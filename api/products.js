// PayPal Sandbox checkout creation. Never accept price or PayPal order IDs from the browser.
const json = (res, status, body) => res.status(status).json(body);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9_-]{16,100}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;



async function createSupportRequest(req,res){
 const {name,email,topic,message,orderReference}=req.body||{};
 if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(email||""))||String(email).length>254||String(name||"").trim().length<2||String(name).length>100||String(topic||"").length<3||String(topic).length>120||String(message||"").length<10||String(message).length>1200||String(orderReference||"").length>80)return json(res,400,{error:"تحقق من بيانات نموذج الدعم"});
 const base=(process.env.SUPABASE_URL||"").replace(/\\/+$/,""),key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!base||!key)return json(res,503,{error:"Service unavailable"});
 const headers={apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"};
 const normalized=String(email).trim().toLowerCase();
 const since=new Date(Date.now()-300000).toISOString();
 try{
  const check=await fetch(base+"/rest/v1/support_requests?customer_email=eq."+encodeURIComponent(normalized)+"&created_at=gte."+encodeURIComponent(since)+"&select=id&limit=1",{headers});
  if(!check.ok)return json(res,502,{error:"Support service unavailable"});
  if((await check.json()).length)return json(res,429,{error:"يرجى الانتظار خمس دقائق قبل إرسال طلب آخر"});
  const r=await fetch(base+"/rest/v1/support_requests",{method:"POST",headers:{...headers,Prefer:"return=representation"},body:JSON.stringify({request_key:crypto.randomUUID().replace(/-/g,""),customer_name:String(name).trim(),customer_email:normalized,topic:String(topic).trim(),message:String(message).trim(),order_reference:String(orderReference||"").trim(),delivery_status:"pending"})});
  const data=await r.json().catch(()=>[]);
  if(!r.ok||!data[0])return json(res,502,{error:"تعذر حفظ طلب الدعم"});
  return json(res,201,{ticketId:data[0].id});
 }catch(e){return json(res,502,{error:"Support service unavailable"});}
}

async function capturePayPalOrder(req,res) {
 if(process.env.VERCEL_ENV==="production") return json(res,403,{error:"Sandbox only"});
 const {orderId,paypalOrderId}=req.body||{};
 if(!uuid.test(String(orderId||""))||!/^[-A-Z0-9]{8,40}$/i.test(String(paypalOrderId||""))) return json(res,400,{error:"Invalid order"});
 const base=(process.env.SUPABASE_URL||"").replace(/\\/+$/,""), key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 const clientId=process.env.PAYPAL_CLIENT_ID, secret=process.env.PAYPAL_CLIENT_SECRET;
 if(!base||!key||!clientId||!secret)return json(res,503,{error:"Missing configuration"});
 const headers={apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"};
 try {
  const found=await fetch(base+"/rest/v1/orders?id=eq."+encodeURIComponent(orderId)+"&paypal_order_id=eq."+encodeURIComponent(paypalOrderId)+"&checkout_method=eq.paypal&select=id,order_number,unit_price,status,customer_id,guest_email",{headers});
  if(!found.ok)return json(res,502,{error:"Order lookup failed"});
  const orders=await found.json();if(orders.length!==1)return json(res,404,{error:"Order not found"});
  const order=orders[0];
  let verified=false;
  const auth=String(req.headers.authorization||"");
  if(order.customer_id&&auth.startsWith("Bearer ")){
   const u=await fetch(base+"/auth/v1/user",{headers:{apikey:key,Authorization:auth}});
   if(u.ok){const person=await u.json();verified=person.id===order.customer_id;}
  }
  if(!verified&&order.guest_email){
   // Guest capture is allowed only with the original unguessable checkout key.
   const checkoutKey=String(req.body?.idempotencyKey||"");
   if(keyPattern.test(checkoutKey)){
    const v=await fetch(base+"/rest/v1/orders?id=eq."+encodeURIComponent(orderId)+"&idempotency_key=eq."+encodeURIComponent(checkoutKey)+"&select=id",{headers});
    verified=v.ok&&(await v.json()).length===1;
   }
  }
  if(!verified)return json(res,403,{error:"Checkout authorization required"});
  if(order.status==="paid"||order.status==="completed")return json(res,200,{success:true,orderId,status:order.status});
  if(order.status!=="awaiting_payment")return json(res,409,{error:"Order is not payable"});
  const t=await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token",{method:"POST",headers:{Authorization:"Basic "+Buffer.from(clientId+":"+secret).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});
  const token=await t.json();if(!t.ok||!token.access_token)return json(res,502,{error:"PayPal authentication failed"});
  const cap=await fetch("https://api-m.sandbox.paypal.com/v2/checkout/orders/"+encodeURIComponent(paypalOrderId)+"/capture",{method:"POST",headers:{Authorization:"Bearer "+token.access_token,"Content-Type":"application/json","PayPal-Request-Id":orderId},body:"{}"});
  const data=await cap.json().catch(()=>({}));
  if(!cap.ok&&data.name!=="ORDER_ALREADY_CAPTURED")return json(res,502,{error:"PayPal capture failed"});
  const check=await fetch("https://api-m.sandbox.paypal.com/v2/checkout/orders/"+encodeURIComponent(paypalOrderId),{headers:{Authorization:"Bearer "+token.access_token}});
  const pp=await check.json().catch(()=>({}));
  const unit=pp.purchase_units?.[0], captures=unit?.payments?.captures||[];
  const paid=captures.some(c=>c.status==="COMPLETED"&&c.amount?.currency_code==="USD"&&Number(c.amount.value)===Number(order.unit_price));
  if(!check.ok||pp.status!=="COMPLETED"||unit?.reference_id!==orderId||unit?.invoice_id!==order.order_number||!paid)return json(res,409,{error:"Payment not verified"});
  const update=await fetch(base+"/rest/v1/orders?id=eq."+encodeURIComponent(orderId)+"&status=eq.awaiting_payment&select=id,status",{method:"PATCH",headers:{...headers,Prefer:"return=representation"},body:JSON.stringify({status:"paid"})});
  if(!update.ok)return json(res,502,{error:"Payment verified but order update failed"});
  return json(res,200,{success:true,orderId,status:"paid"});
 }catch(e){console.error("PayPal capture",e?.message);return json(res,502,{error:"Payment verification temporarily unavailable"});}
}

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
        payment_source: { paypal: { experience_context: {
          user_action: "PAY_NOW",
          return_url: "https://" + process.env.VERCEL_URL + "/",
          cancel_url: "https://" + process.env.VERCEL_URL + "/?checkout=cancelled"
        } } },
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
  if (req.method === 'POST' && req.body?.action === 'support') return createSupportRequest(req, res);
  if (req.method === 'POST' && req.body?.action === 'capture') return capturePayPalOrder(req, res);
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
