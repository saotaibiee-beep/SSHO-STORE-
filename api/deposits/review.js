import { verifyTelegramInitData } from "../_lib/telegram.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !supabaseUrl || !serviceKey) return res.status(503).json({ error: "Server configuration incomplete" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("tma ")) return res.status(401).json({ error: "Telegram authorization required" });
  const user = verifyTelegramInitData(auth.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "Invalid Telegram session" });
  const depositId = Number(req.body?.depositId);
  const customerReference = typeof req.body?.customerReference === "string" ? req.body.customerReference.trim() : "";
  if (!Number.isSafeInteger(depositId) || depositId < 1 || customerReference.length < 3 || customerReference.length > 160 || /[\r\n<>]/.test(customerReference)) return res.status(400).json({ error: "أدخل معرّف Binance أو رقم المعاملة بشكل صحيح" });
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  try {
    const url = new URL(`${supabaseUrl}/rest/v1/deposits`);
    url.search = new URLSearchParams({ id: `eq.${depositId}`, telegram_user_id: `eq.${user.id}`, method: "eq.Binance ID", select: "id,status,customer_reference" }).toString();
    const check = await fetch(url, { headers });
    const rows = await check.json().catch(() => null);
    if (!check.ok) return res.status(502).json({ error: "تعذر التحقق من طلب الشحن" });
    if (!Array.isArray(rows) || !rows[0]) return res.status(404).json({ error: "لم يتم العثور على طلب شحن تابع لحسابك" });
    if (rows[0].status === "pending_review" || rows[0].status === "approved") return res.status(409).json({ error: "تم إرسال هذا الطلب للمراجعة مسبقاً" });
    if (!["awaiting_payment", "pending_verification"].includes(rows[0].status)) return res.status(409).json({ error: "لا يمكن إرسال هذا الطلب للمراجعة" });
    const saveUrl = new URL(`${supabaseUrl}/rest/v1/deposits`);
    saveUrl.search = new URLSearchParams({ id: `eq.${depositId}`, telegram_user_id: `eq.${user.id}`, method: "eq.Binance ID", status: `in.(awaiting_payment,pending_verification)` }).toString();
    const savedRes = await fetch(saveUrl, { method: "PATCH", headers: { ...headers, Prefer: "return=representation" }, body: JSON.stringify({ customer_reference: customerReference, payment_reference: customerReference, status: "pending_review", updated_at: new Date().toISOString() }) });
    const saved = await savedRes.json().catch(() => null);
    if (!savedRes.ok) { console.error("Binance ID review save failed", savedRes.status); return res.status(502).json({ error: "تعذر حفظ طلب المراجعة" }); }
    if (!Array.isArray(saved) || !saved[0]) return res.status(409).json({ error: "تم تحديث الطلب مسبقاً؛ حدّث الصفحة" });
    return res.status(201).json({ ok: true, depositId: saved[0].id, status: saved[0].status, message: "تم إرسال الطلب للمراجعة. لن يضاف الرصيد قبل اعتماد الإدارة." });
  } catch (e) { console.error("Binance ID review error", e?.message); return res.status(502).json({ error: "تعذر الاتصال بخدمة الشحن" }); }
}
