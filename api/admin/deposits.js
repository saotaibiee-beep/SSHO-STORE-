import crypto from "node:crypto";
import { verifyTelegramInitData } from "../_lib/telegram.js";

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_TYPES = {
  "image/jpeg": { ext: "jpg", valid: b => b[0] === 255 && b[1] === 216 && b[2] === 255 },
  "image/png": { ext: "png", valid: b => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
  "image/webp": { ext: "webp", valid: b => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  "image/gif": { ext: "gif", valid: b => ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6)) }
};

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
    if (req.query?.resource === "products") {
      if (req.method === "GET") {
        const listRes = await fetch(`${supabaseUrl}/rest/v1/products?select=id,slug,name,description,image_url,price,currency,category,active,available,stock_count&order=created_at.desc&limit=200`, { headers });
        const products = await listRes.json().catch(() => []);
        if (!listRes.ok) return res.status(502).json({ error: "تعذر تحميل المنتجات" });
        return res.status(200).json({ products });
      }
      if (req.method === "POST") {
        const productId = typeof req.body?.productId === "string" ? req.body.productId : "";
        const mime = typeof req.body?.mimeType === "string" ? req.body.mimeType : "";
        const encoded = typeof req.body?.fileBase64 === "string" ? req.body.fileBase64 : "";
        if (!/^[0-9a-f-]{36}$/i.test(productId)) return res.status(400).json({ error: "معرّف المنتج غير صالح" });
        const spec = IMAGE_TYPES[mime];
        if (!spec || !encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) return res.status(400).json({ error: "اختر صورة JPG أو PNG أو WEBP أو GIF بحجم لا يتجاوز 3 ميجابايت" });
        const bytes = Buffer.from(encoded, "base64");
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !spec.valid(bytes)) return res.status(400).json({ error: "محتوى الصورة غير صالح أو يتجاوز 3 ميجابايت" });
        const productRes = await fetch(`${supabaseUrl}/rest/v1/products?id=eq.${encodeURIComponent(productId)}&select=id`, { headers });
        const found = await productRes.json().catch(() => []);
        if (!productRes.ok || !Array.isArray(found) || !found.length) return res.status(404).json({ error: "المنتج غير موجود" });
        const path = `products/${productId}/${crypto.randomUUID()}.${spec.ext}`;
        const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/product-images/${path.split("/").map(encodeURIComponent).join("/")}`, {
          method: "POST",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": mime, "x-upsert": "false" },
          body: bytes
        });
        if (!uploadRes.ok) {
          console.error("Product image upload failed", uploadRes.status, await uploadRes.text().catch(() => ""));
          return res.status(502).json({ error: "تعذر رفع الصورة إلى التخزين. حاول مرة أخرى." });
        }
        const imageUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${path.split("/").map(encodeURIComponent).join("/")}`;
        const updateRes = await fetch(`${supabaseUrl}/rest/v1/products?id=eq.${encodeURIComponent(productId)}`, {
          method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
          body: JSON.stringify({ image_url: imageUrl, updated_at: new Date().toISOString() })
        });
        const updated = await updateRes.json().catch(() => []);
        if (!updateRes.ok || !Array.isArray(updated) || !updated.length) return res.status(502).json({ error: "تم رفع الصورة لكن تعذر ربطها بالمنتج." });
        return res.status(200).json({ ok: true, image_url: imageUrl, product: updated[0] });
      }
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    if (req.query?.resource === "wallet-deposits" && req.method === "GET") {
      const status = ["pending_verification", "paid", "rejected"].includes(String(req.query?.status)) ? String(req.query.status) : "pending_verification";
      const dRes = await fetch(`${supabaseUrl}/rest/v1/deposits?status=eq.${status}&method=in.(USDT%20BEP20,USDT%20TRC20,USDT%20ERC20,USDT%20SOL)&select=id,telegram_user_id,amount,method,payment_reference,status,created_at&order=created_at.desc&limit=100`, { headers });
      const deposits = await dRes.json().catch(() => []);
      if (!dRes.ok || !Array.isArray(deposits)) return res.status(502).json({ error: "تعذر تحميل طلبات شحن المحفظة" });
      return res.status(200).json({ deposits });
    }

    if (req.query?.resource === "usdt-orders" && req.method === "GET") {
      const status = ["submitted", "under_review", "confirmed", "rejected"].includes(String(req.query?.status)) ? String(req.query.status) : "submitted";
      const pRes = await fetch(`${supabaseUrl}/rest/v1/payments?status=eq.${status}&network=like.USDT*&select=id,order_id,network,asset,amount,txid,receiving_address,status,verification_status,verification_notes,submitted_by,submitted_at&order=submitted_at.desc&limit=100`, { headers });
      const payments = await pRes.json().catch(() => []);
      if (!pRes.ok || !Array.isArray(payments)) return res.status(502).json({ error: "تعذر تحميل طلبات الدفع المباشر" });
      const ids = [...new Set(payments.map(p => p.order_id).filter(Boolean))];
      let orderMap = {};
      if (ids.length) {
        const oRes = await fetch(`${supabaseUrl}/rest/v1/orders?id=in.(${ids.join(",")})&select=id,order_number,telegram_id,product_name,unit_price,currency,status,created_at`, { headers });
        const orders = await oRes.json().catch(() => []);
        if (!oRes.ok) return res.status(502).json({ error: "تعذر تحميل تفاصيل الطلبات" });
        orderMap = Object.fromEntries(orders.map(o => [o.id, o]));
      }
      return res.status(200).json({ payments: payments.map(p => ({ ...p, order: orderMap[p.order_id] || null })) });
    }

    if (req.query?.resource === "wallet-deposits") {
      const depositId = Number(req.body?.depositId);
      const decision = String(req.body?.decision || "");
      if (!Number.isSafeInteger(depositId) || depositId <= 0 || !["confirmed", "rejected"].includes(decision)) {
        return res.status(400).json({ error: "بيانات مراجعة الشحن غير صالحة" });
      }
      const rpc = await fetch(`${supabaseUrl}/rest/v1/rpc/review_usdt_wallet_deposit`, {
        method: "POST", headers,
        body: JSON.stringify({ p_deposit_id: depositId, p_decision: decision, p_admin_telegram_id: user.id })
      });
      const result = await rpc.json().catch(() => ({}));
      if (!rpc.ok) {
        const msg = String(result?.message || "");
        if (msg.includes("admin_forbidden")) return res.status(403).json({ error: "ليس لديك صلاحية اعتماد الشحن" });
        if (msg.includes("deposit_not_pending_review")) return res.status(409).json({ error: "طلب الشحن ليس بانتظار المراجعة." });
        console.error("Review USDT wallet deposit failed", rpc.status, msg.slice(0, 200));
        return res.status(502).json({ error: "تعذر حفظ مراجعة الشحن" });
      }
      const dr = await fetch(`${supabaseUrl}/rest/v1/deposits?id=eq.${depositId}&select=telegram_user_id,amount,status&limit=1`, { headers });
      const rows = await dr.json().catch(() => []);
      if (rows?.[0]) {
        const msg = decision === "confirmed"
          ? `تم اعتماد شحن محفظتك عبر USDT\\nرقم الشحن: ${depositId}\\nالمبلغ المضاف: ${rows[0].amount} USDT\\nيمكنك الآن الشراء من رصيد المحفظة.`
          : `تعذر اعتماد طلب شحن USDT رقم ${depositId}. يرجى التواصل مع الدعم قبل إعادة التحويل.`;
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: rows[0].telegram_user_id, text: msg, disable_web_page_preview: true })
        }).catch(() => null);
      }
      return res.status(200).json({ ok: true, result, message: decision === "confirmed" ? "تم اعتماد الشحن وإضافة الرصيد للمحفظة." : "تم رفض طلب الشحن." });
    }

    if (req.query?.resource === "usdt-orders" && req.method === "PATCH") {
    const paymentId = String(req.body?.paymentId || "");
    const decision = String(req.body?.decision || "");
    const note = String(req.body?.note || "").slice(0, 1000);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentId) || !["confirmed", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "بيانات المراجعة غير صالحة" });
    }
    const rpc = await fetch(`${supabaseUrl}/rest/v1/rpc/review_usdt_store_payment`, {
      method: "POST", headers,
      body: JSON.stringify({ p_payment_id: paymentId, p_decision: decision, p_admin_telegram_id: user.id, p_note: note })
    });
    const result = await rpc.json().catch(() => ({}));
    if (!rpc.ok) {
      const msg = String(result?.message || "");
      if (msg.includes("admin_forbidden")) return res.status(403).json({ error: "ليس لديك صلاحية اعتماد الدفع" });
      if (msg.includes("product_unavailable")) return res.status(409).json({ error: "المنتج غير متوفر أو نفد المخزون؛ لم يتم اعتماد الدفع." });
      if (msg.includes("payment_already_reviewed") || msg.includes("order_not_payable")) return res.status(409).json({ error: "تمت مراجعة هذا الدفع أو أن الطلب لم يعد قابلاً للدفع." });
      console.error("Review USDT payment RPC failed", rpc.status, msg.slice(0, 200));
      return res.status(502).json({ error: "تعذر حفظ مراجعة الدفع" });
    }
    const orderRes = result.order_id ? await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${result.order_id}&select=telegram_id,order_number,product_name,status&limit=1`, { headers }) : null;
    const orderRows = orderRes ? await orderRes.json().catch(() => []) : [];
    if (Array.isArray(orderRows) && orderRows[0]) {
      const o = orderRows[0];
      const msg = decision === "confirmed"
        ? `تم تأكيد دفع طلبك بنجاح\\nرقم الطلب: ${o.order_number}\\nالمنتج: ${o.product_name}\\nالحالة: مدفوع — جارٍ التجهيز.\\nالتسليم فوري عادةً وقد يستغرق حتى 30 دقيقة.`
        : `تعذر اعتماد إثبات دفع طلبك\\nرقم الطلب: ${o.order_number}\\nيرجى مراجعة رقم المعاملة والتواصل مع الدعم قبل إعادة الدفع.`;
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: o.telegram_id, text: msg, disable_web_page_preview: true })
      }).catch(() => null);
    }
    return res.status(200).json({ ok: true, result, message: decision === "confirmed" ? "تم تأكيد الدفع وتحويل الطلب إلى مدفوع." : "تم رفض إثبات الدفع." });

    }

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
