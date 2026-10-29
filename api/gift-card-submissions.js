import { verifyTelegramInitData } from "./_lib/telegram.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !supabaseUrl || !serviceKey) return res.status(503).json({ error: "Server configuration incomplete" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("tma ")) return res.status(401).json({ error: "Telegram authorization required" });
  const user = verifyTelegramInitData(auth.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "Invalid Telegram session" });

  const depositId = Number(req.body?.depositId);
  const cardCode = typeof req.body?.cardCode === "string" ? req.body.cardCode.trim() : "";
  if (!Number.isSafeInteger(depositId) || depositId < 1 || cardCode.length < 8 || cardCode.length > 120 || /[\r\n<>]/.test(cardCode)) {
    return res.status(400).json({ error: "تحقق من رقم الطلب وكود البطاقة" });
  }
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  try {
    const depRes = await fetch(`${supabaseUrl}/rest/v1/deposits?id=eq.${depositId}&telegram_user_id=eq.${user.id}&method=eq.Binance%20Gift%20Card&select=id,amount,method,status`, { headers });
    const deposits = await depRes.json().catch(() => []);
    if (!depRes.ok) return res.status(502).json({ error: "تعذر التحقق من طلب الشحن" });
    if (!Array.isArray(deposits) || !deposits[0]) return res.status(404).json({ error: "لم يتم العثور على طلب بطاقة تابع لحسابك" });
    const deposit = deposits[0];
    if (["paid", "cancelled"].includes(deposit.status)) return res.status(409).json({ error: "لا يمكن إرسال كود لهذا الطلب" });

    const saveRes = await fetch(`${supabaseUrl}/rest/v1/binance_gift_card_submissions?on_conflict=deposit_id`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        deposit_id: deposit.id,
        telegram_user_id: user.id,
        customer_name: user.first_name || null,
        customer_username: user.username || null,
        amount: deposit.amount,
        card_code: cardCode,
        status: "pending_review",
        updated_at: new Date().toISOString()
      })
    });
    const saved = await saveRes.json().catch(() => []);
    if (!saveRes.ok || !Array.isArray(saved) || !saved[0]?.id) {
      console.error("Gift card submission save failed", saveRes.status);
      return res.status(502).json({ error: "تعذر حفظ طلب البطاقة. حاول مرة أخرى." });
    }
    const patchRes = await fetch(`${supabaseUrl}/rest/v1/deposits?id=eq.${deposit.id}&telegram_user_id=eq.${user.id}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "pending_verification", updated_at: new Date().toISOString() })
    });
    if (!patchRes.ok) console.error("Gift card deposit status update failed", patchRes.status);
    return res.status(201).json({ ok: true, submissionId: saved[0].id, depositId: deposit.id, status: saved[0].status });
  } catch (error) {
    console.error("Gift card submission failed", error?.message);
    return res.status(502).json({ error: "تعذر الاتصال بخدمة الشحن" });
  }
}