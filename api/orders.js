export default async function handler(req, res) {
res.setHeader("Cache-Control", "no-store");

if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({
error: "Method not allowed"
});
}

return res.status(503).json({
error: "Order creation is not enabled yet",
message: "Secure customer verification must be configured before accepting orders."
});
}
