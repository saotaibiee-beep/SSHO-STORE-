import { verifyTelegramInitData } from "./_lib/telegram.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !supabaseUrl || !serviceKey) {
    return res.status(503).json({ error: "Server configuration incomplete" });
  }

  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("tma ")) {
    return res.status(401).json({ error: "Telegram authorization required" });
  }
  const user = verifyTelegramInitData(authorization.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "Invalid Telegram session" });

  const depositId = Number(req.body?.depositId);
  const cardCode = typeof req.body?.cardCode === "string" ? req.body.cardCode.trim() : "";
  if (!Number.isSafeInteger(depositId) || depositId < 1 ||
      cardCode.length < 8 || cardCode.length > 120 || /[\r\n<>]/.test(cardCode)) {
    return res.status(400).json({ error: "تحقق من رقم الطلب وكود البطاقة" });
  }

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

  try {
    const depUrl = new URL(`${supabaseUrl}/rest/v1/deposits`);
    depUrl.search = new URLSearchParams({
      id: `eq.${depositId}`,
      telegram_user_id: `eq.${user.id}`,
      method: "eq.Binance Gift Card",
      select: "id,amount,method,status"
    }).toString();

    const depRes = await fetch(depUrl, { headers });
    const deposits = await depRes.json().catch(() => null);
    if (!depRes.ok) return res.status(502).json({ error: "تعذر التحقق من طلب الشحن" });
    if (!Array.isArray(deposits) || !deposits[0]) {
      return res.status(404).json({ error: "لم يتم العثور على طلب بطاقة تابع لحسابك" });
    }

    const deposit = deposits[0];
    if (!["awaiting_payment", "pending_verification", "pending_review"].includes(deposit.status)) {
      return res.status(409).json({ error: "لا يمكن إرسال كود لهذا الطلب" });
    }

    // Insert once per deposit: never overwrite an approved/rejected submission back to pending.
    const saveUrl = new URL(`${supabaseUrl}/rest/v1/binance_gift_card_submissions`);
    const saveRes = await fetch(saveUrl, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({
        deposit_id: deposit.id,
        telegram_user_id: user.id,
        customer_name: user.first_name || null,
        customer_username: user.username || null,
        amount: deposit.amount,
        card_code: cardCode,
        status: "pending_review"
      })
    });
    const saved = await saveRes.json().catch(() => null);

    if (!saveRes.ok) {
      if (saveRes.status === 409 || saveRes.status === 400) {
        return res.status(409).json({
          error: "تم إرسال بطاقة لهذا الطلب مسبقاً. لا يمكن إعادة فتح الطلب أو استبدال حالته."
        });
      }
      console.error("Gift card submission save failed", saveRes.status);
      return res.status(502).json({ error: "تعذر حفظ طلب البطاقة." });
    }
    if (!Array.isArray(saved) || !saved[0]?.id) {
      return res.status(502).json({ error: "تعذر تأكيد حفظ طلب البطاقة." });
    }

    // The submission itself is the authoritative pending-review record.
    // Do not mutate deposit status in a separate, non-atomic request.
    return res.status(201).json({
      ok: true,
      submissionId: saved[0].id,
      depositId: deposit.id,
      status: saved[0].status,
      message: "تم استلام البطاقة للمراجعة؛ لن يضاف الرصيد حتى يعتمدها مشرف مخول."
    });
  } catch (error) {
    console.error("Gift card submission failed", error?.message);
    return res.status(502).json({ error: "تعذر الاتصال بخدمة الشحن" });
  }
}
