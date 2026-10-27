export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(500).json({
      error: "Supabase configuration is missing"
    });
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/products?select=id,slug,name,description,image_url,price,currency,category,available,active,stock_count&active=eq.true&available=eq.true`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`
        }
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        error: "Could not load products"
      });
    }

    const products = await response.json();
    return res.status(200).json({ products });
  } catch {
    return res.status(500).json({
      error: "Unexpected server error"
    });
  }
}
