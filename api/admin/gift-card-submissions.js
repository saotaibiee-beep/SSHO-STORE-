import { verifyTelegramInitData } from "../_lib/telegram.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !supabaseUrl || !serviceKey) {
    return res.status(503).json({ error: "Server configuration incomplete" });
  }

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("tma ")) {
    return res.status(401).json({ error: "Telegram authorization required" });
  }
  const user = verifyTelegramInitData(auth.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "Invalid Telegram session" });

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

  try {
    const roleRes = await fetch(
      `${supabaseUrl}/rest/v1/admin_roles?telegram_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=role`,
      { headers }
    );
    const roles = await roleRes.json().catch(() => []);
    if (!roleRes.ok) return res.status(502).json({ error: "تعذر التحقق من صلاحيات الإدارة" });
    if (!Array.isArray(roles) || !roles.some(r => ["owner", "admin"].includes(r.role))) {
      return res.status(403).json({ error: "ليس لديك صلاحية إدارة أكواد البطاقات" });
    }

    if (req.method === "GET") {
      const status = ["pending_review", "approved", "rejected"].includes(req.query?.status)
        ? req.query.status : "pending_review";
      const listRes = await fetch(
        `${supabaseUrl}/rest/v1/binance_gift_card_submissions?status=eq.${status}&select=id,deposit_id,telegram_user_id,customer_name,customer_username,amount,card_code,status,admin_note,created_at&order=created_at.desc&limit=100`,
        { headers }
      );
      const rows = await listRes.json().catch(() => []);
      if (!listRes.ok) return res.status(502).json({ error: "تعذر تحميل الطلبات" });
      return res.status(200).json({ submissions: rows });
    }

    if (req.method === "PATCH") {
      const id = Number(req.body?.id);
      const status = req.body?.status;
      const adminNote = typeof req.body?.adminNote === "string" ? req.body.adminNote.slice(0, 1000) : "";
      if (!Number.isSafeInteger(id) || id < 1 || !["approved", "rejected"].includes(status)) {
        return res.status(400).json({ error: "بيانات التحديث غير صحيحة" });
      }

      const reviewRes = await fetch(`${supabaseUrl}/rest/v1/rpc/review_binance_gift_card_submission`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_submission_id: id,
          p_status: status,
          p_admin_note: adminNote,
          p_reviewed_by: user.id
        })
      });
      const result = await reviewRes.json().catch(() => null);
      if (!reviewRes.ok) {
        if (reviewRes.status === 400 || reviewRes.status === 404 || reviewRes.status === 409) {
          return res.status(409).json({
            error: "تعذر اعتماد الطلب: ربما تمت مراجعته سابقاً أو أن الإيداع المرتبط به غير صالح."
          });
        }
        console.error("Gift card review RPC failed", reviewRes.status);
        return res.status(502).json({ error: "تعذر حفظ المراجعة بشكل آمن" });
      }
      return res.status(200).json({
        ok: true,
        status: result?.status || status,
        idempotent: Boolean(result?.idempotent),
        balanceCredited: false,
        message: "تم تحديث حالة البطاقة والإيداع المرتبط بها وتسجيل العملية. لم تتم إضافة رصيد تلقائياً."
      });
    }

    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("Admin gift card API failed", error?.message);
    return res.status(502).json({ error: "تعذر الاتصال بخدمة الإدارة" });
  }
}
