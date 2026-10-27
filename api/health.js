export default function handler(req, res) {
  const configured = Boolean(
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.TELEGRAM_BOT_TOKEN
  );

  return res.status(200).json({
    status: "ok",
    configured,
    supabaseConfigured: Boolean(
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
    ),
    telegramConfigured: Boolean(
      process.env.TELEGRAM_BOT_TOKEN
    )
  });
}
