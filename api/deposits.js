
import { verifyTelegramInitData } from "./_lib/telegram.js";

const METHODS = new Set([
  "USDT BEP20",
  "USDT TRC20",
  "USDT ERC20",
  "USDT SOL",
  "Binance ID",
  "Binance Gift Card"
]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!botToken || !supabaseUrl || !serviceKey) {
    return res.status(503).json({
      error: "Server configuration incomplete"
    });
  }

  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("tma ")) {
    return res.status(401).json({
      error: "Telegram authorization required"
    });
  }

  const user = verifyTelegramInitData(
    authorization.slice(4),
    botToken
  );

  if (!user) {
    return res.status(401).json({
      error: "Invalid Telegram session"
    });
  }

  const body = req.body || {};
  const baseUrl = supabaseUrl.replace(/\\/+$/, "");
  const headers = { "Content-Type": "application/json", apikey: serviceKey, Authorization: "Bearer " + serviceKey };

  if (body.action === "submit_usdt") {
    const depositId = Number(body.depositId);
    const network = String(body.method || "");
    const txid = String(body.txid || "").trim();
    const networkRules = {
      "USDT BEP20": /^0x[0-9a-fA-F]{64}$/,
      "USDT ERC20": /^0x[0-9a-fA-F]{64}$/,
      "USDT TRC20": /^[A-Za-z0-9]{60,70}$/,
      "USDT SOL": /^[1-9A-HJ-NP-Za-km-z]{80,100}$/
    };
    if (!Number.isSafeInteger(depositId) || depositId <= 0 || !networkRules[network] || !networkRules[network].test(txid)) {
      return res.status(400).json({ error: "أدخل رقم معاملة صحيحاً واختر الشبكة المطابقة." });
    }
    try {
      const q = new URLSearchParams({ id: "eq." + depositId, telegram_user_id: "eq." + user.id, method: "eq." + network, select: "id,amount,status,payment_reference", limit: "1" });
      const dr = await fetch(baseUrl + "/rest/v1/deposits?" + q.toString(), { headers });
      const rows = await dr.json().catch(() => []);
      const deposit = rows?.[0];
      if (!dr.ok) return res.status(502).json({ error: "تعذر تحميل طلب الشحن" });
      if (!deposit) return res.status(404).json({ error: "طلب الشحن غير موجود أو الشبكة لا تطابق الطلب." });
      if (deposit.status === "pending_verification" && String(deposit.payment_reference || "").toLowerCase() === txid.toLowerCase()) {
        return res.status(200).json({ ok: true, status: deposit.status, depositId, duplicate: true });
      }
      if (deposit.status !== "awaiting_payment") return res.status(409).json({ error: "طلب الشحن لا يقبل إثبات دفع جديداً." });
      const dupeQ = new URLSearchParams({ payment_reference: "ilike." + txid, select: "id", limit: "1" });
      const dupeRes = await fetch(baseUrl + "/rest/v1/deposits?" + dupeQ.toString(), { headers });
      const dupeRows = await dupeRes.json().catch(() => []);
      if (!dupeRes.ok) return res.status(502).json({ error: "تعذر التحقق من تكرار رقم المعاملة" });
      if (dupeRows?.length) return res.status(409).json({ error: "رقم المعاملة مسجل مسبقاً." });
      const updateRes = await fetch(baseUrl + "/rest/v1/deposits?id=eq." + depositId + "&telegram_user_id=eq." + user.id + "&status=eq.awaiting_payment", {
        method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ payment_reference: txid, status: "pending_verification", updated_at: new Date().toISOString() })
      });
      const updated = await updateRes.json().catch(() => []);
      if (!updateRes.ok || !updated?.length) return res.status(409).json({ error: "تعذر تسجيل إثبات الدفع؛ حدّث الصفحة وتحقق من حالة الطلب." });
      const ar = await fetch(baseUrl + "/rest/v1/admin_roles?active=eq.true&role=in.(owner,admin)&select=telegram_id&limit=10", { headers });
      const admins = await ar.json().catch(() => []);
      const msg = "طلب شحن USDT جديد\\nرقم الشحن: " + depositId + "\\nالمبلغ: " + deposit.amount + " USDT\\nالشبكة: " + network + "\\nTxID: " + txid + "\\nتحقق من التحويل قبل إضافة الرصيد.";
      if (ar.ok && Array.isArray(admins)) await Promise.all(admins.filter(a => a.telegram_id).map(a => fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: a.telegram_id, text: msg, disable_web_page_preview: true }) }).catch(() => null)));
      return res.status(201).json({ ok: true, depositId, status: "pending_verification", message: "تم إرسال إثبات الشحن للمراجعة. لن يضاف الرصيد قبل اعتماد الإدارة." });
    } catch (error) {
      console.error("Submit USDT wallet deposit failed", error?.message);
      return res.status(502).json({ error: "تعذر إرسال إثبات الشحن" });
    }
  }

  const amount = Number(body.amount);
  const method = body.method;

  if (
    !Number.isFinite(amount) ||
    amount < 1 ||
    amount > 10000 ||
    typeof method !== "string" ||
    !METHODS.has(method)
  ) {
    return res.status(400).json({
      error: "Invalid deposit request"
    });
  }

  try {
    const baseUrl = supabaseUrl.replace(/\/+$/, "");

    const response = await fetch(
      `${baseUrl}/rest/v1/deposits`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          telegram_user_id: user.id,
          amount,
          method,
          status: "awaiting_payment"
        })
      }
    );

    const rows = await response.json().catch(() => null);

    if (!response.ok || !Array.isArray(rows) || !rows[0]?.id) {
      console.error("Create deposit failed", response.status);
      return res.status(502).json({
        error: "Could not create deposit request"
      });
    }

    return res.status(201).json({
      depositId: rows[0].id,
      amount: rows[0].amount,
      method: rows[0].method,
      status: rows[0].status,
      message: "Request created; payment is not verified."
    });
  } catch (error) {
    console.error("Create deposit request failed", error?.message);
    return res.status(502).json({
      error: "Deposit service temporarily unavailable"
    });
  }
}
