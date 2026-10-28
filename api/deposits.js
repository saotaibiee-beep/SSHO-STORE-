
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
