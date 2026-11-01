import crypto from "node:crypto";
import { verifyTelegramInitData } from "../_lib/telegram.js";

const MAX_BYTES = 3 * 1024 * 1024;
const MIME = {
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
  "image/webp": { ext: "webp", magic: (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  "image/gif": { ext: "gif", magic: (b) => ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6)) }
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !supabaseUrl || !serviceKey) return res.status(503).json({ error: "Server configuration incomplete" });

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("tma ")) return res.status(401).json({ error: "Telegram authorization required" });
  const user = verifyTelegramInitData(auth.slice(4), botToken);
  if (!user) return res.status(401).json({ error: "Invalid Telegram session" });

  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  try {
    const roleRes = await fetch(`${supabaseUrl}/rest/v1/admin_roles?telegram_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=role`, { headers });
    const roles = await roleRes.json().catch(() => []);
    if (!roleRes.ok) return res.status(502).json({ error: "تعذر التحقق من صلاحيات الإدارة" });
    if (!Array.isArray(roles) || !roles.some((r) => ["owner", "admin"].includes(r.role))) return res.status(403).json({ error: "ليس لديك صلاحية إدارة المنتجات" });

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
      const spec = MIME[mime];
      if (!spec || !encoded || encoded.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) return res.status(400).json({ error: "اختر صورة JPG أو PNG أو WEBP أو GIF بحجم لا يتجاوز 3 ميجابايت" });
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.length > MAX_BYTES || !spec.magic(bytes)) return res.status(400).json({ error: "محتوى الصورة غير صالح أو يتجاوز 3 ميجابايت" });

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
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ image_url: imageUrl, updated_at: new Date().toISOString() })
      });
      const updated = await updateRes.json().catch(() => []);
      if (!updateRes.ok || !Array.isArray(updated) || !updated.length) return res.status(502).json({ error: "تم رفع الصورة لكن تعذر ربطها بالمنتج. أعد المحاولة أو تواصل مع الدعم." });
      return res.status(200).json({ ok: true, image_url: imageUrl, product: updated[0] });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("Admin products API failed", error?.message);
    return res.status(502).json({ error: "تعذر الاتصال بخدمة إدارة المنتجات" });
  }
}
