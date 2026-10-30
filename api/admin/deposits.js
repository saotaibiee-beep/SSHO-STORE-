import { verifyTelegramInitData } from "../_lib/telegram.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  const botToken = process.env.TELEGRAM_BOT_TOKEN, supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, ""), serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !supabaseUrl || !serviceKey) return res.status(503).json({ error: "Server configuration incomplete" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("tma ")) return res.status(401).json({ error: "Telegram authorization required" });
  const user = verifyTelegramInitData(auth.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "Invalid Telegram session" });
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  try {
    const rr = await fetch(`${supabaseUrl}/rest/v1/admin_roles?telegram_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=role`, { headers });
    const roles = await rr.json().catch(() => []);
    if (!rr.ok) return res.status(502).json({ error: "تعذر التحقق من صلاحيات الإدارة" });
    if (!Array.isArray(roles) || !roles.some(x => ["owner", "admin"].includes(x.role))) return res.status(403).json({ error: "ليس لديك صلاحية الإدارة" });
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
    const status = ["pending_review", "approved", "rejected"].includes(req.query?.status) ? req.query.status : "pending_review";
    const url = new URL(`${supabaseUrl}/rest/v1/deposits`);
    url.search = new URLSearchParams({ method: "eq.Binance ID", status: `eq.${status}`, select: "id,telegram_user_id,amount,method,customer_reference,payment_reference,status,created_at", order: "created_at.desc", limit: "100" }).toString();
    const response = await fetch(url, { headers });
    const deposits = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(deposits)) return res.status(502).json({ error: "تعذر تحميل طلبات Binance ID" });
    return res.status(200).json({ deposits });
  } catch (e) { console.error("Admin Binance ID deposits failed", e?.message); return res.status(502).json({ error: "تعذر الاتصال بخدمة الإدارة" }); }
}
