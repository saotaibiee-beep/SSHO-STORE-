import { verifyTelegramInitData } from "./_lib/telegram.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    res.setHeader("Allow", "GET, POST, DELETE");
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
      error: "Invalid or expired Telegram session"
    });
  }

  const baseUrl = supabaseUrl.replace(/\/+$/, "");

  if (req.method === "DELETE") {
    const orderId = String(req.body?.orderId || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      return res.status(400).json({ error: "معرّف الطلب غير صالح" });
    }

    try {
      // Soft-delete only unpaid orders. Keep the order and all related financial records.
      const query = new URLSearchParams({
        id: `eq.${orderId}`,
        telegram_id: `eq.${user.id}`,
        status: "eq.awaiting_payment",
        is_deleted: "eq.false",
        select: "id,status,is_deleted"
      });

      const response = await fetch(`${baseUrl}/rest/v1/orders?${query.toString()}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Prefer: "return=representation"
        },
        body: JSON.stringify({ is_deleted: true })
      });

      const result = await response.json().catch(() => null);
      if (!response.ok) {
        console.error("Soft-delete order failed", response.status, JSON.stringify(result).slice(0, 180));
        return res.status(502).json({ error: "تعذر إخفاء الطلب حالياً. حاول مرة أخرى." });
      }

      if (!Array.isArray(result) || result.length === 0) {
        const checkQuery = new URLSearchParams({
          select: "id,status,is_deleted",
          id: `eq.${orderId}`,
          telegram_id: `eq.${user.id}`,
          limit: "1"
        });
        const check = await fetch(`${baseUrl}/rest/v1/orders?${checkQuery.toString()}`, {
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
        });
        const rows = await check.json().catch(() => []);
        if (!Array.isArray(rows) || rows.length === 0) {
          return res.status(404).json({ error: "الطلب غير موجود." });
        }
        if (rows[0].is_deleted === true) {
          return res.status(200).json({ success: true, hidden: true, orderId });
        }
        if (rows[0].status === "completed" || rows[0].status === "paid") {
          return res.status(409).json({ error: "لا يمكن إخفاء الطلب المدفوع أو المكتمل حفاظاً على السجل المالي." });
        }
        return res.status(409).json({ error: "يمكن إخفاء الطلبات التي بانتظار الدفع فقط." });
      }

      return res.status(200).json({ success: true, hidden: true, orderId: result[0].id });
    } catch (error) {
      console.error("Soft-delete order request failed", error?.message);
      return res.status(502).json({ error: "تعذر إخفاء الطلب حالياً. حاول مرة أخرى." });
    }
  }

  if (req.method === "GET") {
    try {
      const query = new URLSearchParams({
        select: "id,order_number,product_name,unit_price,currency,status,created_at",
        telegram_id: `eq.${user.id}`,
        is_deleted: "eq.false",
        order: "created_at.desc",
        limit: "100"
      });

      const response = await fetch(
        `${baseUrl}/rest/v1/orders?${query.toString()}`,
        {
          method: "GET",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`
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

      return res.status(200).json({
        orders: result || []
      });
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
    return res.status(400).json({
      error: "Invalid order request"
    });
  }

  try {
    const response = await fetch(
      `${baseUrl}/rest/v1/rpc/create_store_order`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`
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
      const rpcMessage = String(result?.message || result?.details || "");
      if (rpcMessage.includes("insufficient_balance")) {
        return res.status(409).json({ code: "INSUFFICIENT_BALANCE", error: "رصيدك غير كافٍ لإتمام الشراء." });
      }
      if (rpcMessage.includes("product_unavailable")) {
        return res.status(409).json({ code: "PRODUCT_UNAVAILABLE", error: "المنتج غير متوفر حالياً." });
      }
      if (rpcMessage.includes("wallet_currency_mismatch") || rpcMessage.includes("unsupported_wallet_currency")) {
        return res.status(409).json({ code: "CURRENCY_MISMATCH", error: "عملة رصيد المحفظة لا تطابق عملة المنتج." });
      }
      console.error("Order RPC failed", response.status, rpcMessage.slice(0, 180));
      return res.status(502).json({ error: "تعذر إتمام الشراء بأمان. لم يُعتمد الطلب." });
    }

    return res.status(201).json(result);
  } catch (error) {
    console.error("Order request failed", error?.message);
    return res.status(502).json({
      error: "Order service temporarily unavailable"
    });
  }
}
