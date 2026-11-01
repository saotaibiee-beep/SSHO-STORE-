import { verifyTelegramInitData } from "./_lib/telegram.js";

const jsonHeaders = { "Content-Type": "application/json" };
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !base || !key) return res.status(503).json({ error: "Server configuration incomplete" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("tma ")) return res.status(401).json({ error: "افتح المتجر من تيليجرام للتحقق من هويتك." });
  const user = verifyTelegramInitData(auth.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "جلسة تيليجرام غير صالحة أو منتهية." });
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  async function isAdmin() {
    const r = await fetch(`${base}/rest/v1/admin_roles?telegram_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=role`, { headers });
    const roles = await r.json().catch(() => []);
    return r.ok && Array.isArray(roles) && roles.some(x => ["owner", "admin"].includes(x.role));
  }
  try {
    if (req.method === "POST") {
      const b = req.body || {};
      const card_type = String(b.card_type || "").trim();
      const card_code = String(b.card_code || "").trim();
      const wallet = String(b.usdt_wallet_address || "").trim();
      const face_value = Number(b.face_value);
      const currency = String(b.currency || "USD").toUpperCase();
      if (card_type.length < 2 || card_type.length > 80 || card_code.length < 4 || card_code.length > 300 ||
          !Number.isFinite(face_value) || face_value <= 0 || face_value > 1000000 ||
          !["USD","SAR","EUR","GBP"].includes(currency) || wallet.length < 20 || wallet.length > 160) {
        return res.status(400).json({ error: "تحقق من نوع البطاقة والكود والقيمة وعنوان محفظة USDT." });
      }
      const r = await fetch(`${base}/rest/v1/card_sell_requests`, {
        method: "POST", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ telegram_id: user.id, customer_name: String(user.first_name || "").slice(0,120), card_type, card_code, face_value, currency, usdt_wallet_address: wallet, status: "pending_review" })
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) { console.error("card sell submit failed", r.status); return res.status(502).json({ error: "تعذر حفظ الطلب الآن. حاول لاحقاً." }); }
      return res.status(201).json({ ok: true, request: { id: data?.[0]?.id, status: "pending_review" }, message: "تم استلام طلبك وسيُراجع يدوياً. لا يتم تحويل USDT قبل التحقق من صلاحية البطاقة." });
    }
    if (req.method === "GET") {
      if (!await isAdmin()) return res.status(403).json({ error: "هذه الصفحة مخصصة للإدارة." });
      const status = ["pending_review","completed","rejected","all"].includes(req.query?.status) ? req.query.status : "pending_review";
      const q = new URLSearchParams({ select: "id,telegram_id,customer_name,card_type,card_code,face_value,currency,usdt_wallet_address,status,rejection_reason,created_at,reviewed_at,reviewed_by", order: "created_at.desc", limit: "100" });
      if (status !== "all") q.set("status", `eq.${status}`);
      const r = await fetch(`${base}/rest/v1/card_sell_requests?${q}`, { headers });
      const data = await r.json().catch(() => []);
      if (!r.ok) return res.status(502).json({ error: "تعذر تحميل الطلبات." });
      return res.status(200).json({ requests: data });
    }
    if (req.method === "PATCH") {
      if (!await isAdmin()) return res.status(403).json({ error: "هذه العملية مخصصة للإدارة." });
      const id = String(req.body?.id || "");
      const status = req.body?.status;
      const reason = String(req.body?.rejection_reason || "").trim().slice(0,1000);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !["completed","rejected"].includes(status) || (status === "rejected" && !reason)) {
        return res.status(400).json({ error: "اختر حالة صحيحة واكتب سبب الرفض عند رفض الطلب." });
      }
      const q = new URLSearchParams({ id: `eq.${id}`, status: "eq.pending_review", select: "id,status" });
      const r = await fetch(`${base}/rest/v1/card_sell_requests?${q}`, {
        method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ status, rejection_reason: status === "rejected" ? reason : null, reviewed_by: user.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) return res.status(502).json({ error: "تعذر حفظ القرار." });
      if (!Array.isArray(data) || !data.length) return res.status(409).json({ error: "الطلب غير موجود أو تمت مراجعته سابقاً." });
      return res.status(200).json({ ok: true, status, message: status === "completed" ? "تم تسجيل اكتمال الطلب. تأكد أن التحويل الخارجي تم فعلياً قبل اختيار هذه الحالة." : "تم رفض الطلب وحفظ السبب." });
    }
    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("card sell API error", e?.message);
    return res.status(502).json({ error: "الخدمة غير متاحة مؤقتاً." });
  }
}