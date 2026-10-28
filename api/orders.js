
import { verifyTelegramInitData } from "./_lib/telegram.js";

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
    return res.status(401).json({ error: "Telegram authorization required" });
  }

  const user = verifyTelegramInitData(
    authorization.slice(4),
    botToken
  );

  if (!user) {
    return res.status(401).json({
      error: "Invalid or expired Telegram session"
    });
  }
if (req.method === "GET") {
try {
const baseUrl = supabaseUrl.replace(//+$/, "");
const query = new URLSearchParams({
select: "id,order_number,product_name,unit_price,currency,status,created_at",
telegram_id: "eq.${user.id}",
order: "created_at.desc",
limit: "100"
});

  const response = await fetch(
    `${baseUrl}/rest/v1/orders?${query.toString()}`,
    {
      method: "GET",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`
      }
    }
  );

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Fetch orders failed", response.status);
    return res.status(502).json({
      error: "Could not fetch orders"
    });
  }

  return res.status(200).json({ orders: result || [] });
} catch (error) {
  console.error("Fetch orders request failed", error?.message);
  return res.status(502).json({
    error: "Order service temporarily unavailable"
  });
}

}
  const { productId, idempotencyKey } = req.body || {};

  if (
    typeof productId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId) ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 16 ||
    idempotencyKey.length > 100
  ) {
    return res.status(400).json({ error: "Invalid order request" });
  }

  try {
    const baseUrl = supabaseUrl.replace(/\/+$/, "");

    const response = await fetch(
      `${baseUrl}/rest/v1/rpc/create_store_order`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceKey,
          "Authorization": `Bearer ${serviceKey}`
        },
        body: JSON.stringify({
          p_telegram_id: user.id,
          p_product_id: productId,
          p_idempotency_key: idempotencyKey
        })
      }
    );

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      if (
        response.status === 400 &&
        result?.message?.includes("product_unavailable")
      ) {
        return res.status(409).json({
          error: "Product unavailable"
        });
      }

      console.error("Order RPC failed", response.status);
      return res.status(502).json({
        error: "Could not create order"
      });
    }

    return res.status(201).json(result);
  } catch (error) {
    console.error("Order request failed", error?.message);
    return res.status(502).json({
      error: "Order service temporarily unavailable"
    });
  }
}
