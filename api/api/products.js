export default async function handler(req, res) {
if (req.method !== "GET") {
res.setHeader("Allow", "GET");
return res.status(405).json({ error: "Method not allowed" });
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
return res.status(500).json({
error: "Supabase environment variables are not configured"
});
}

try {
const response = await fetch(
`${supabaseUrl}/rest/v1/products?select=*`,
{
headers: {
apikey: supabaseKey,
Authorization: `Bearer ${supabaseKey}`
}
}
);

if (!response.ok) {
  return res.status(502).json({
    error: "Could not retrieve products from the database"
  });
}

const products = await response.json();

return res.status(200).json({ products });

} catch (error) {
return res.status(500).json({
error: "An unexpected server error occurred"
});
}
}
