import { verifyTelegramInitData } from "../_lib/telegram.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (!["GET", "PATCH"].includes(req.method)) {
    res.setHeader("Allow", "GET, PATCH");
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
  try {
    const roleRes = await fetch(`${base}/rest/v1/admin_roles?telegram_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=role`, { headers });
    const roles = await roleRes.json().catch(() => []);
    if (!roleRes.ok) return res.status(502).json({ error: "تعذر التحقق من صلاحيات الإدارة" });
    if (!Array.isArray(roles) || !roles.some(r => ["owner", "admin"].includes(r.role))) return res.status(403).json({ error: "ليس لديك صلاحية إدارة الطلبات" });

    if (req.method === "GET") {
      const status = ["submitted", "under_review", "confirmed", "rejected"].includes(String(req.query?.status)) ? String(req.query.status) : "submitted";
      const pRes = await fetch(`${base}/rest/v1/payments?status=eq.${status}&network=like.USDT*&select=id,order_id,network,asset,amount,txid,receiving_address,status,verification_status,verification_notes,submitted_by,submitted_at&order=submitted_at.desc&limit=100`, { headers });
      const payments = await pRes.json().catch(() => []);
      if (!pRes.ok || !Array.isArray(payments)) return res.status(502).json({ error: "تعذر تحميل طلبات الدفع المباشر" });
      const ids = [...new Set(payments.map(p => p.order_id).filter(Boolean))];
      let orderMap = {};
      if (ids.length) {
        const oRes = await fetch(`${base}/rest/v1/orders?id=in.(${ids.join(",")})&select=id,order_number,telegram_id,product_name,unit_price,currency,status,created_at`, { headers });
        const orders = await oRes.json().catch(() => []);
        if (!oRes.ok) return res.status(502).json({ error: "تعذر تحميل تفاصيل الطلبات" });
        orderMap = Object.fromEntries(orders.map(o => [o.id, o]));
      }
      return res.status(200).json({ payments: payments.map(p => ({ ...p, order: orderMap[p.order_id] || null })) });
    }

    const paymentId = String(req.body?.paymentId || "");
    const decision = String(req.body?.decision || "");
    const note = String(req.body?.note || "").slice(0, 1000);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentId) || !["confirmed", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "بيانات المراجعة غير صالحة" });
    }
    const rpc = await fetch(`${base}/rest/v1/rpc/review_usdt_store_payment`, {
      method: "POST", headers,
      body: JSON.stringify({ p_payment_id: paymentId, p_decision: decision, p_admin_telegram_id: user.id, p_note: note })
    });
    const result = await rpc.json().catch(() => ({}));
    if (!rpc.ok) {
      const msg = String(result?.message || "");
      if (msg.includes("admin_forbidden")) return res.status(403).json({ error: "ليس لديك صلاحية اعتماد الدفع" });
      if (msg.includes("product_unavailable")) return res.status(409).json({ error: "المنتج غير متوفر أو نفد المخزون؛ لم يتم اعتماد الدفع." });
      if (msg.includes("payment_already_reviewed") || msg.includes("order_not_payable")) return res.status(409).json({ error: "تمت مراجعة هذا الدفع أو أن الطلب لم يعد قابلاً للدفع." });
      console.error("Review USDT payment RPC failed", rpc.status, msg.slice(0, 200));
      return res.status(502).json({ error: "تعذر حفظ مراجعة الدفع" });
    }
    const orderRes = result.order_id ? await fetch(`${base}/rest/v1/orders?id=eq.${result.order_id}&select=telegram_id,order_number,product_name,status&limit=1`, { headers }) : null;
    const orderRows = orderRes ? await orderRes.json().catch(() => []) : [];
    if (Array.isArray(orderRows) && orderRows[0]) {
      const o = orderRows[0];
      const msg = decision === "confirmed"
        ? `تم تأكيد دفع طلبك بنجاح\\nرقم الطلب: ${o.order_number}\\nالمنتج: ${o.product_name}\\nالحالة: مدفوع — جارٍ التجهيز.\\nالتسليم فوري عادةً وقد يستغرق حتى 30 دقيقة.`
        : `تعذر اعتماد إثبات دفع طلبك\\nرقم الطلب: ${o.order_number}\\nيرجى مراجعة رقم المعاملة والتواصل مع الدعم قبل إعادة الدفع.`;
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: o.telegram_id, text: msg, disable_web_page_preview: true })
      }).catch(() => null);
    }
    return res.status(200).json({ ok: true, result, message: decision === "confirmed" ? "تم تأكيد الدفع وتحويل الطلب إلى مدفوع." : "تم رفض إثبات الدفع." });
  } catch (error) {
    console.error("Admin USDT payment review error", error?.message);
    return res.status(502).json({ error: "تعذر الاتصال بخدمة الإدارة" });
  }
}
