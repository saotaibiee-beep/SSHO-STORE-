import crypto from "node:crypto";
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
  const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
  const IMAGE_TYPES = {
    "image/jpeg": { ext: "jpg", valid: b => b[0] === 255 && b[1] === 216 && b[2] === 255 },
    "image/png": { ext: "png", valid: b => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
    "image/webp": { ext: "webp", valid: b => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
    "image/gif": { ext: "gif", valid: b => ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6)) }
  };
  try {
    const rr = await fetch(`${supabaseUrl}/rest/v1/admin_roles?telegram_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=role`, { headers });
    const roles = await rr.json().catch(() => []);
    if (!rr.ok) return res.status(502).json({ error: "تعذر التحقق من صلاحيات الإدارة" });
    if (!Array.isArray(roles) || !roles.some(x => ["owner", "admin"].includes(x.role))) return res.status(403).json({ error: "ليس لديك صلاحية الإدارة" });

    if (req.query?.resource === "products") {
      if (req.method === "GET") {
        const listRes = await fetch(`${supabaseUrl}/rest/v1/products?select=id,slug,name,image_url,price,currency,category,active,available,stock_count&order=created_at.desc&limit=200`, { headers });
        const products = await listRes.json().catch(() => []);
        if (!listRes.ok || !Array.isArray(products)) return res.status(502).json({ error: "تعذر تحميل المنتجات" });
        return res.status(200).json({ products });
      }
      if (req.method === "POST") {
        const productId = typeof req.body?.productId === "string" ? req.body.productId : "";
        const mime = typeof req.body?.mimeType === "string" ? req.body.mimeType : "";
        const encoded = typeof req.body?.fileBase64 === "string" ? req.body.fileBase64 : "";
        if (!/^[0-9a-f-]{36}$/i.test(productId)) return res.status(400).json({ error: "معرّف المنتج غير صالح" });
        const spec = IMAGE_TYPES[mime];
        if (!spec || !encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) return res.status(400).json({ error: "اختر صورة مدعومة بحجم لا يتجاوز 3 ميجابايت" });
        const bytes = Buffer.from(encoded, "base64");
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !spec.valid(bytes)) return res.status(400).json({ error: "محتوى الصورة غير صالح أو يتجاوز 3 ميجابايت" });
        const productRes = await fetch(`${supabaseUrl}/rest/v1/products?id=eq.${encodeURIComponent(productId)}&select=id`, { headers });
        const found = await productRes.json().catch(() => []);
        if (!productRes.ok || !Array.isArray(found) || !found.length) return res.status(404).json({ error: "المنتج غير موجود" });
        const path = `products/${productId}/${crypto.randomUUID()}.${spec.ext}`;
        const objectPath = path.split("/").map(encodeURIComponent).join("/");
        const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/product-images/${objectPath}`, {
          method: "POST",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": mime, "x-upsert": "false" },
          body: bytes
        });
        if (!uploadRes.ok) {
          console.error("Product image upload failed", uploadRes.status, await uploadRes.text().catch(() => ""));
          return res.status(502).json({ error: "تعذر رفع الصورة إلى التخزين. حاول مرة أخرى." });
        }
        const imageUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${objectPath}`;
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
