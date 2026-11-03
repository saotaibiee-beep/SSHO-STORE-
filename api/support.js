import { verifyTelegramInitData } from "./_lib/telegram.js";

const jsonHeaders = { "Content-Type": "application/json" };

async function dbRequest(url, key, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...jsonHeaders,
      ...(options.headers || {})
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[ch]);
}

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
    return res.status(503).json({ error: "خدمة الدعم غير مكتملة الإعداد." });
  }

  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("tma ")) {
    return res.status(401).json({ error: "افتح المتجر من خلال تيليجرام." });
  }
  const user = verifyTelegramInitData(authorization.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "جلسة تيليجرام غير صالحة. أعد فتح المتجر." });

  const { requestKey, topic, orderReference, message } = req.body || {};
  if (typeof requestKey !== "string" || !/^[a-zA-Z0-9_-]{12,100}$/.test(requestKey) ||
      typeof topic !== "string" || !topic.trim() || topic.length > 120 ||
      typeof orderReference !== "string" || orderReference.length > 80 ||
      typeof message !== "string" || message.trim().length < 3 || message.length > 1200) {
    return res.status(400).json({ error: "يرجى إدخال موضوع الرسالة وتفاصيل صحيحة." });
  }

  const tableUrl = `${supabaseUrl}/rest/v1/support_requests`;
  const requestQuery = new URLSearchParams({
    request_key: `eq.${requestKey}`,
    select: "id,delivery_status,telegram_message_id",
    limit: "1"
  });

  try {
    let saved;
    const existingResponse = await dbRequest(`${tableUrl}?${requestQuery}`, serviceKey);
    const existing = await existingResponse.json().catch(() => []);
    if (existingResponse.ok && Array.isArray(existing) && existing.length) {
      saved = existing[0];
      if (saved.telegram_user_id && Number(saved.telegram_user_id) !== Number(user.id)) {
        return res.status(409).json({ error: "مفتاح الطلب مستخدم مسبقاً." });
      }
      if (saved.delivery_status === "sent") {
        return res.status(200).json({ delivered: true, ticketId: saved.id });
      }
    } else {
      const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "عميل تيليجرام";
      const insertResponse = await dbRequest(tableUrl, serviceKey, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([{
          request_key: requestKey,
          telegram_user_id: user.id,
          customer_name: fullName,
          customer_username: user.username,
          order_reference: orderReference.trim(),
          topic: topic.trim(),
          message: message.trim(),
          delivery_status: "pending"
        }])
      });
      const inserted = await insertResponse.json().catch(() => null);
      if (!insertResponse.ok || !Array.isArray(inserted) || !inserted[0]) {
        console.error("Support request persistence failed", insertResponse.status);
        return res.status(502).json({ error: "تعذر حفظ رسالة الدعم. لم نؤكد إرسالها؛ حاول مرة أخرى." });
      }
      saved = inserted[0];
    }

    const adminResponse = await dbRequest(
      `${supabaseUrl}/rest/v1/admin_roles?active=eq.true&role=in.(owner,admin)&select=telegram_id,role&order=role.asc&limit=10`,
      serviceKey
    );
    const admins = await adminResponse.json().catch(() => []);
    if (!adminResponse.ok || !Array.isArray(admins) || !admins.length) {
      throw new Error("لا يوجد حساب دعم نشط مضبوط في صلاحيات الإدارة.");
    }

    // Confirm that the configured administrator account is exactly @abnasi before sending.
    let recipient = null;
    for (const admin of admins) {
      const chatResponse = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(admin.telegram_id)}`);
      const chatResult = await chatResponse.json().catch(() => null);
      if (chatResponse.ok && chatResult?.ok &&
          String(chatResult.result?.username || "").toLowerCase() === "abnasi") {
        recipient = admin.telegram_id;
        break;
      }
    }
    if (!recipient) {
      throw new Error("تعذر التحقق من أن حساب الإدارة النشط هو @abnasi. لم تُرسل الرسالة.");
    }

    const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "غير متوفر";
    const username = user.username ? `@${user.username}` : "غير متوفر (لا يوجد Username)";
    const text =
      `📩 <b>رسالة دعم جديدة — SSHO STORE</b>\n\n` +
      `👤 <b>اسم العميل:</b> ${escapeHtml(fullName)}\n` +
      `🆔 <b>معرّف تيليجرام:</b> <code>${user.id}</code>\n` +
      `🔗 <b>Username:</b> ${escapeHtml(username)}\n` +
      `🧾 <b>رقم الطلب:</b> ${escapeHtml(orderReference.trim() || "غير مذكور")}\n` +
      `📌 <b>موضوع المشكلة:</b> ${escapeHtml(topic.trim())}\n\n` +
      `📝 <b>تفاصيل المشكلة:</b>\n${escapeHtml(message.trim())}\n\n` +
      `🎫 <b>رقم المتابعة:</b> <code>${saved.id}</code>`;

    const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        chat_id: recipient,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    const telegramResult = await telegramResponse.json().catch(() => null);
    if (!telegramResponse.ok || !telegramResult?.ok) {
      throw new Error("تعذر تسليم الرسالة إلى محادثة الدعم في تيليجرام.");
    }

    const updateResponse = await dbRequest(
      `${tableUrl}?id=eq.${encodeURIComponent(saved.id)}`,
      serviceKey,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          delivery_status: "sent",
          telegram_message_id: telegramResult.result?.message_id ?? null,
          delivered_at: new Date().toISOString(),
          delivery_error: null
        })
      }
    );
    if (!updateResponse.ok) {
      console.error("Support delivery status update failed", updateResponse.status);
    }

    return res.status(200).json({ delivered: true, ticketId: saved.id });
  } catch (error) {
    console.error("Support delivery failed", error?.message);
    return res.status(502).json({
      delivered: false,
      error: "تم حفظ طلبك، لكن تعذر تأكيد وصوله إلى الدعم الآن. حاول الإرسال مجدداً، ولن نفقد بيانات الرسالة."
    });
  }
}
