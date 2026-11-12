// PayPal Sandbox checkout creation. Never accept price or PayPal order IDs from the browser.
const json = (res, status, body) => res.status(status).json(body);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9_-]{16,100}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function createPayPalOrder(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }
  // This endpoint is sandbox-only until a separately reviewed production rollout.
  if (process.env.VERCEL_ENV === "production") return json(res, 403, { error: "Checkout testing is limited to preview" });
  const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: secret, SUPABASE_URL: rawUrl, SUPABASE_SERVICE_ROLE_KEY: serviceKey } = process.env;
  if (!clientId || !secret || !rawUrl || !serviceKey) return json(res, 503, { error: "Checkout environment is not configured" });
  const base = rawUrl.replace(/\/+$/, "");
  const { productId, idempotencyKey, email } = req.body || {};
  if (!uuid.test(String(productId || "")) || !keyPattern.test(String(idempotencyKey || ""))) return json(res, 400, { error: "Invalid checkout request" });
  let customerId = null;
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) {
    const response = await fetch(base + "/auth/v1/user", { headers: { apikey: serviceKey, Authorization: auth } });
    if (!response.ok) return json(res, 401, { error: "Invalid customer session" });
    const user = await response.json().catch(() => null);
    if (!uuid.test(String(user?.id || ""))) return json(res, 401, { error: "Invalid customer session" });
    customerId = user.id;
  }
  const guestEmail = String(email || "").trim().toLowerCase();
  if (!customerId && (guestEmail.length > 254 || !emailPattern.test(guestEmail))) return json(res, 400, { error: "Enter a valid customer email" });
  const dbHeaders = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
  try {
    const created = await fetch(base + "/rest/v1/rpc/create_paypal_checkout_order", {
      method: "POST", headers: dbHeaders,
      body: JSON.stringify({ p_product_id: productId, p_idempotency_key: idempotencyKey, p_customer_id: customerId, p_guest_email: customerId ? null : guestEmail })
    });
    const rows = await created.json().catch(() => null);
    if (!created.ok || !Array.isArray(rows) || !rows[0]) {
      console.error("Checkout order RPC rejected", created.status);
      return json(res, created.status === 400 ? 400 : 409, { error: "Unable to create checkout order" });
    }
    const order = rows[0];
    if (order.paypal_order_id) return json(res, 200, { orderId: order.order_id, paypalOrderId: order.paypal_order_id, sandbox: true });
    const tokenResponse = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
      method: "POST", headers: { Authorization: "Basic " + Buffer.from(clientId + ":" + secret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials"
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) return json(res, 502, { error: "PayPal Sandbox authentication failed" });
    const amount = Number(order.amount);
    if (!Number.isFinite(amount) || amount <= 0) return json(res, 502, { error: "Invalid stored order amount" });
    const paypalResponse = await fetch("https://api-m.sandbox.paypal.com/v2/checkout/orders", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + tokenData.access_token,
        "Content-Type": "application/json",
        "PayPal-Request-Id": order.order_id,
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: order.order_id,
          custom_id: order.order_id,
          invoice_id: order.order_number,
          amount: { currency_code: "USD", value: amount.toFixed(2) }
        }]
      })
    });
    const paypal = await paypalResponse.json().catch(() => ({}));
    if (!paypalResponse.ok || !paypal.id) {
      console.error("PayPal order creation failed", paypalResponse.status, paypal.name);
      return json(res, 502, { error: "PayPal could not create the order" });
    }
    const save = await fetch(base + "/rest/v1/orders?id=eq." + encodeURIComponent(order.order_id) + "&paypal_order_id=is.null&select=id,paypal_order_id", {
      method: "PATCH", headers: { ...dbHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ paypal_order_id: paypal.id })
    });
    const saved = await save.json().catch(() => []);
    if (!save.ok || !Array.isArray(saved) || saved.length !== 1) return json(res, 502, { error: "Unable to persist PayPal order reference" });
    const approveUrl = Array.isArray(paypal.links) ? paypal.links.find(x => x.rel === "payer-action" || x.rel === "approve")?.href : null;
    return json(res, 201, { orderId: order.order_id, paypalOrderId: paypal.id, approveUrl, sandbox: true });
  } catch (error) {
    console.error("PayPal checkout creation error", error?.message);
    return json(res, 502, { error: "Checkout service temporarily unavailable" });
  }
}

export default async function handler(req, res) {
  if (req.method === 'POST') return createPayPalOrder(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: "Supabase configuration is missing" });
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/products?select=id,slug,name,description,important_notes,how_to_use,image_url,price,currency,category,available,active,stock_count&active=eq.true&available=eq.true`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!response.ok) return res.status(502).json({ error: "Could not load products", details: await response.text() });
    const products = (await response.json()).map((p) => {
      if (p.slug === "youtube-premium-individual-3-months" || p.slug === "youtube-premium-individual-1-month") {
        const duration = p.slug === "youtube-premium-individual-1-month" ? "شهر واحد" : "3 أشهر";
        return { ...p, important_notes: p.important_notes || "تنبيه مهم: المنتج حساب جاهز وليس كود تفعيل، ولا يُستخدم لتفعيل الاشتراك على حسابك الحالي.", how_to_use: p.how_to_use || `1. راجع تفاصيل الحساب قبل الشراء.\n2. استخدم بيانات التسليم لتسجيل الدخول.\n3. غيّر بيانات الأمان عند توفر الخيار.\nالمدة: ${duration}. المنطقة: عالمية (GLOBAL).` };
      }
      return p;
    });
    return res.status(200).json({ products });
  } catch {
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
