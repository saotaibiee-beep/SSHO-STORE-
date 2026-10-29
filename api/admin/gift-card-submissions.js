import { verifyTelegramInitData } from "../_lib/telegram.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !supabaseUrl || !serviceKey) return res.status(503).json({ error: "Server configuration incomplete" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("tma ")) return res.status(401).json({ error: "Telegram authorization required" });
  const user = verifyTelegramInitData(auth.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "Invalid Telegram session" });

  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  try {
    const roleRes = await fetch(`${supabaseUrl}/rest/v1/admin_roles?telegram_id=eq.${user.id}&active=eq.true&select=role`, { headers });
    const roles = await roleRes.json().catch(() => []);
    if (!roleRes.ok) return res.status(502).json({ error: "تعذر التحقق من صلاحيات الإدارة" });
    if (!Array.isArray(roles) || !roles.some(r => ["owner", "admin"].includes(r.role))) return res.status(403).json({ error: "ليس لديك صلاحية عرض أكواد البطاقات" });

    if (req.method === "GET") {
      const status = ["pending_review", "approved", "rejected"].includes(req.query?.status) ? req.query.status : "pending_review";
      const listRes = await fetch(`${supabaseUrl}/rest/v1/binance_gift_card_submissions?status=eq.${status}&select=id,deposit_id,telegram_user_id,customer_name,customer_username,amount,card_code,status,admin_note,created_at&order=created_at.desc&limit=100`, { headers });
      const rows = await listRes.json().catch(() => []);
      if (!listRes.ok) return res.status(502).json({ error: "تعذر تحميل الطلبات" });
      return res.status(200).json({ submissions: rows });
    }

    if (req.method === "PATCH") {
      const id = Number(req.body?.id);
      const status = req.body?.status;
      const adminNote = typeof req.body?.adminNote === "string" ? req.body.adminNote.slice(0, 1000) : null;
      if (!Number.isSafeInteger(id) || id < 1 || !["approved", "rejected", "pending_review"].includes(status)) return res.status(400).json({ error: "بيانات التحديث غير صحيحة" });
      const updateRes = await fetch(`${supabaseUrl}/rest/v1/binance_gift_card_submissions?id=eq.${id}`, {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ status, admin_note: adminNote, reviewed_by: user.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      });
      const updated = await updateRes.json().catch(() => []);
      if (!updateRes.ok || !Array.isArray(updated) || !updated[0]) return res.status(502).json({ error: "تعذر تحديث الطلب" });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("Admin gift card API failed", error?.message);
    return res.status(502).json({ error: "تعذر الاتصال بخدمة الإدارة" });
  }
}