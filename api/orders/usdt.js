import { verifyTelegramInitData } from "../_lib/telegram.js";

const NETWORKS = {
  "USDT BEP20": { address: process.env.STORE_BEP20_ADDRESS || "0x58a0486de1f5f812c574a9b19b6cda426486d837", pattern: /^0x[0-9a-fA-F]{64}$/ },
  "USDT TRC20": { address: "TYcN3LQmFrVvRudaH42nyFvWjpzkfVLV4i", pattern: /^[A-Za-z0-9]{60,70}$/ },
  "USDT ERC20": { address: "0x58a0486de1f5f812c574a9b19b6cda426486d837", pattern: /^0x[0-9a-fA-F]{64}$/ },
  "USDT SOL": { address: "HoAS8BFm332G1Y6dv9puEHnfG8pXtRwcD3TXUoEjUaGM", pattern: /^[1-9A-HJ-NP-Za-km-z]{80,100}$/ }
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !base || !key) return res.status(503).json({ error: "Server configuration incomplete" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("tma ")) return res.status(401).json({ error: "Telegram authorization required" });
  const user = verifyTelegramInitData(auth.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "Invalid Telegram session" });

  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const body = req.body || {};
  const action = body.action;

  try {
    if (action === "create") {
      const productId = String(body.productId || "");
      const idempotencyKey = String(body.idempotencyKey || "");
      if (!/^[0-9a-f-]{36}$/i.test(productId) || idempotencyKey.length < 16 || idempotencyKey.length > 100) {
        return res.status(400).json({ error: "بيانات الطلب غير صالحة" });
      }
      const productRes = await fetch(`${base}/rest/v1/products?id=eq.${encodeURIComponent(productId)}&select=id,name,price,currency,active,available,stock_count&limit=1`, { headers });
      const products = await productRes.json().catch(() => []);
      if (!productRes.ok) return res.status(502).json({ error: "تعذر التحقق من المنتج" });
      const product = products?.[0];
      if (!product || !product.active || !product.available || (product.stock_count !== null && Number(product.stock_count) < 1)) {
        return res.status(409).json({ code: "PRODUCT_UNAVAILABLE", error: "المنتج غير متوفر حالياً." });
      }
      const existingRes = await fetch(`${base}/rest/v1/orders?telegram_id=eq.${user.id}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,order_number,status,unit_price,currency,product_name&limit=1`, { headers });
      const existing = await existingRes.json().catch(() => []);
      if (!existingRes.ok) return res.status(502).json({ error: "تعذر التحقق من الطلب" });
      if (existing?.length) return res.status(200).json({ order: existing[0], duplicate: true });
      const orderRes = await fetch(`${base}/rest/v1/orders`, {
        method: "POST", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          telegram_id: user.id, product_id: product.id, product_name: product.name,
          unit_price: Number(product.price), currency: "USDT", status: "awaiting_payment",
          idempotency_key: idempotencyKey, is_deleted: false
        })
      });
      const orders = await orderRes.json().catch(() => []);
      if (!orderRes.ok || !Array.isArray(orders) || !orders[0]) {
        console.error("Create direct USDT order failed", orderRes.status, JSON.stringify(orders).slice(0, 300));
        return res.status(502).json({ error: "تعذر إنشاء الطلب. لم يتم تحصيل أي مبلغ." });
      }
      return res.status(201).json({ order: orders[0], duplicate: false });
    }

    if (action === "submit") {
      const orderId = String(body.orderId || "");
      const network = String(body.network || "");
      const txid = String(body.txid || "").trim();
      const networkConfig = NETWORKS[network];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId) ||
          !networkConfig || !networkConfig.pattern.test(txid)) {
        return res.status(400).json({ error: "تحقق من الشبكة ورقم المعاملة ثم أعد المحاولة." });
      }
      const orderRes = await fetch(`${base}/rest/v1/orders?id=eq.${orderId}&telegram_id=eq.${user.id}&is_deleted=eq.false&select=id,order_number,product_name,unit_price,currency,status&limit=1`, { headers });
      const orders = await orderRes.json().catch(() => []);
      const order = orders?.[0];
      if (!orderRes.ok) return res.status(502).json({ error: "تعذر تحميل الطلب" });
      if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
      if (order.status !== "awaiting_payment" || order.currency !== "USDT") return res.status(409).json({ error: "هذا الطلب لا يقبل الدفع حالياً." });

      const dupRes = await fetch(`${base}/rest/v1/payments?txid=eq.${encodeURIComponent(txid)}&select=id&limit=1`, { headers });
      const duplicates = await dupRes.json().catch(() => []);
      if (!dupRes.ok) return res.status(502).json({ error: "تعذر التحقق من رقم المعاملة" });
      if (duplicates?.length) return res.status(409).json({ error: "رقم المعاملة مسجل مسبقاً." });

      const priorRes = await fetch(`${base}/rest/v1/payments?order_id=eq.${orderId}&select=id,status&limit=1`, { headers });
      const prior = await priorRes.json().catch(() => []);
      if (!priorRes.ok) return res.status(502).json({ error: "تعذر التحقق من الدفع السابق" });
      if (prior?.some(p => ["submitted", "under_review", "confirmed"].includes(p.status))) {
        return res.status(409).json({ error: "تم إرسال إثبات الدفع لهذا الطلب مسبقاً." });
      }

      const payRes = await fetch(`${base}/rest/v1/payments`, {
        method: "POST", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          order_id: order.id, network, asset: "USDT", amount: Number(order.unit_price),
          txid, receiving_address: networkConfig.address, status: "submitted",
          verification_status: "pending", submitted_by: user.id
        })
      });
      const payments = await payRes.json().catch(() => []);
      if (!payRes.ok || !Array.isArray(payments) || !payments[0]) {
        console.error("Submit direct USDT payment failed", payRes.status, JSON.stringify(payments).slice(0, 300));
        return res.status(502).json({ error: "تعذر تسجيل إثبات الدفع. تواصل مع الدعم قبل إعادة التحويل." });
      }

      const adminsRes = await fetch(`${base}/rest/v1/admin_roles?active=eq.true&role=in.(owner,admin)&select=telegram_id&limit=10`, { headers });
      const admins = await adminsRes.json().catch(() => []);
      const text = `طلب USDT مباشر جديد\\nرقم الطلب: ${order.order_number}\\nالمنتج: ${order.product_name}\\nالقيمة: ${order.unit_price} USDT\\nالشبكة: ${network}\\nTxID: ${txid}\\nتحقق من التحويل قبل اعتماد الطلب.`;
      if (adminsRes.ok && Array.isArray(admins)) {
        await Promise.all(admins.filter(a => a.telegram_id).map(a => fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: a.telegram_id, text, disable_web_page_preview: true })
        }).catch(() => null)));
      }
      return res.status(201).json({ ok: true, paymentId: payments[0].id, orderNumber: order.order_number, status: "submitted" });
    }

    return res.status(400).json({ error: "إجراء غير معروف" });
  } catch (error) {
    console.error("Direct USDT order error", error?.message);
    return res.status(502).json({ error: "تعذر إكمال العملية حالياً. لم يتم تأكيد الدفع." });
  }
}
