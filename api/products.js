export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: "Supabase configuration is missing" });
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/products?select=id,slug,name,description,important_notes,how_to_use,image_url,price,currency,category,available,active,stock_count&active=eq.true&available=eq.true`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!response.ok) return res.status(502).json({ error: "Could not load products", details: await response.text() });
    const products = (await response.json()).map((p) => {
      if (p.slug === "youtube-premium-individual-3-months" || p.slug === "youtube-premium-individual-1-month") {
        const duration = p.slug === "youtube-premium-individual-1-month" ? "شهر واحد" : "3 أشهر";
        return { ...p, important_notes: p.important_notes || "تنبيه مهم: المنتج حساب جاهز وليس كود تفعيل، ولا يُستخدم لتفعيل الاشتراك على حسابك الحالي.", how_to_use: p.how_to_use || `1. راجع تفاصيل الحساب قبل الشراء.\n2. استخدم بيانات التسليم لتسجيل الدخول.\n3. غيّر بيانات الأمان عند توفر الخيار.\nالمدة: ${duration}. المنطقة: عالمية (GLOBAL).` };
      }
      return p;
    });
    return res.status(200).json({ products });
  } catch {
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
