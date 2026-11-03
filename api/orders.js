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

  if (req.body?.action === "support") {
    const { requestKey, topic, orderReference, message } = req.body || {};
    if (typeof requestKey !== "string" || !/^[a-zA-Z0-9_-]{12,100}$/.test(requestKey) ||
        typeof topic !== "string" || !topic.trim() || topic.length > 120 ||
        typeof orderReference !== "string" || orderReference.length > 80 ||
        typeof message !== "string" || message.trim().length < 3 || message.length > 1200) {
      return res.status(400).json({ error: "يرجى إدخال موضوع الرسالة وتفاصيل صحيحة." });
    }
    const tableUrl = `${baseUrl}/rest/v1/support_requests`;
    const query = new URLSearchParams({ request_key: `eq.${requestKey}`, select: "id,telegram_user_id,delivery_status", limit: "1" });
    try {
      const existingResponse = await fetch(`${tableUrl}?${query}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      const existing = await existingResponse.json().catch(() => []);
      let saved;
      if (existingResponse.ok && Array.isArray(existing) && existing.length) {
        saved = existing[0];
        if (Number(saved.telegram_user_id) !== Number(user.id)) return res.status(409).json({ error: "مفتاح الطلب مستخدم مسبقاً." });
        if (saved.delivery_status === "sent") return res.status(200).json({ delivered: true, ticketId: saved.id });
      } else {
        const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "عميل تيليجرام";
        const insertResponse = await fetch(tableUrl, {
          method: "POST",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify([{
            request_key: requestKey, telegram_user_id: user.id, customer_name: fullName,
            customer_username: user.username, order_reference: orderReference.trim(),
            topic: topic.trim(), message: message.trim(), delivery_status: "pending"
          }])
        });
        const inserted = await insertResponse.json().catch(() => null);
        if (!insertResponse.ok || !Array.isArray(inserted) || !inserted[0]) {
          console.error("Support request persistence failed", insertResponse.status);
          return res.status(502).json({ error: "تعذر حفظ رسالة الدعم. حاول مرة أخرى." });
        }
        saved = inserted[0];
      }

      const adminsResponse = await fetch(`${baseUrl}/rest/v1/admin_roles?active=eq.true&role=in.(owner,admin)&select=telegram_id,role&limit=10`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
      });
      const admins = await adminsResponse.json().catch(() => []);
      if (!adminsResponse.ok || !Array.isArray(admins) || !admins.length) throw new Error("لا يوجد حساب دعم نشط.");
      let recipient = null;
      for (const admin of admins) {
        const check = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(admin.telegram_id)}`);
        const chat = await check.json().catch(() => null);
        if (check.ok && chat?.ok && String(chat.result?.username || "").toLowerCase() === "abnasi") {
          recipient = admin.telegram_id;
          break;
        }
      }
      if (!recipient) throw new Error("تعذر التحقق من أن حساب الإدارة النشط هو @abnasi.");

      const esc = value => String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
      const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "غير متوفر";
      const username = user.username ? `@${user.username}` : "غير متوفر (لا يوجد Username)";
      const text =
        `📩 <b>رسالة دعم جديدة — SSHO STORE</b>\\n\\n` +
        `👤 <b>اسم العميل:</b> ${esc(fullName)}\\n` +
        `🆔 <b>معرّف تيليجرام:</b> <code>${user.id}</code>\\n` +
        `🔗 <b>Username:</b> ${esc(username)}\\n` +
        `🧾 <b>رقم الطلب:</b> ${esc(orderReference.trim() || "غير مذكور")}\\n` +
        `📌 <b>موضوع المشكلة:</b> ${esc(topic.trim())}\\n\\n` +
        `📝 <b>تفاصيل المشكلة:</b>\\n${esc(message.trim())}\\n\\n` +
        `🎫 <b>رقم المتابعة:</b> <code>${saved.id}</code>`;
      const sent = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: recipient, text, parse_mode: "HTML", disable_web_page_preview: true })
      });
      const result = await sent.json().catch(() => null);
      if (!sent.ok || !result?.ok) throw new Error("تعذر تسليم الرسالة إلى دعم تيليجرام.");

      await fetch(`${tableUrl}?id=eq.${encodeURIComponent(saved.id)}`, {
        method: "PATCH",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ delivery_status: "sent", telegram_message_id: result.result?.message_id ?? null, delivered_at: new Date().toISOString(), delivery_error: null })
      });
      return res.status(200).json({ delivered: true, ticketId: saved.id });
    } catch (error) {
      console.error("Support delivery failed", error?.message);
      return res.status(502).json({ delivered: false, error: "تم حفظ طلبك، لكن تعذر تأكيد وصوله إلى الدعم الآن. حاول مجدداً؛ بيانات رسالتك محفوظة." });
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
