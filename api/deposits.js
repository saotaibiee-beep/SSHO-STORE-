
import { verifyTelegramInitData } from "./_lib/telegram.js";

const METHODS = new Set([
  "USDT BEP20",
  "USDT TRC20",
  "USDT ERC20",
  "USDT SOL",
  "Binance ID",
  "Binance Gift Card"
]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");



  if(req.method==="POST"&&req.body?.action==="submit_reference"){
    const base=process.env.SUPABASE_URL?.replace(/[/]+$/,""),key=process.env.SUPABASE_SERVICE_ROLE_KEY;
    const auth=String(req.headers.authorization||"");
    if(!base||!key)return res.status(503).json({error:"Service unavailable"});
    if(!auth.startsWith("Bearer "))return res.status(401).json({error:"Login required"});
    const u=await fetch(base+"/auth/v1/user",{headers:{apikey:key,Authorization:auth}});
    if(!u.ok)return res.status(401).json({error:"Invalid session"});
    const user=await u.json();
    const depositId=Number(req.body.depositId),reference=String(req.body.reference||"").trim();
    if(!Number.isSafeInteger(depositId)||depositId<1||reference.length<4||reference.length>150)return res.status(400).json({error:"Invalid transfer reference"});
    const headers={apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json",Prefer:"return=representation"};
    const query="/rest/v1/deposits?id=eq."+depositId+"&customer_id=eq."+encodeURIComponent(user.id)+"&status=eq.awaiting_payment&select=id";
    const r=await fetch(base+query,{method:"PATCH",headers,body:JSON.stringify({customer_reference:reference,status:"under_review"})});
    const rows=await r.json().catch(()=>[]);
    if(!r.ok||!rows.length)return res.status(409).json({error:"Deposit cannot be updated"});
    return res.status(200).json({submitted:true});
  }

  if(req.method==="POST"&&req.body?.action==="approve"){
    const base=process.env.SUPABASE_URL?.replace(/[/]+$/,""),key=process.env.SUPABASE_SERVICE_ROLE_KEY;
    const auth=String(req.headers.authorization||"");
    if(!base||!key)return res.status(503).json({error:"Service unavailable"});
    if(!auth.startsWith("Bearer "))return res.status(401).json({error:"Authentication required"});
    const u=await fetch(base+"/auth/v1/user",{headers:{apikey:key,Authorization:auth}});
    if(!u.ok)return res.status(401).json({error:"Invalid session"});
    const user=await u.json();
    const headers={apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"};
    const admin=await fetch(base+"/rest/v1/store_admins?user_id=eq."+encodeURIComponent(user.id)+"&active=eq.true&select=user_id&limit=1",{headers});
    if(!admin.ok||(await admin.json()).length!==1)return res.status(403).json({error:"Admin access required"});
    const depositId=Number(req.body.depositId);
    if(!Number.isSafeInteger(depositId)||depositId<1)return res.status(400).json({error:"Invalid deposit"});
    const r=await fetch(base+"/rest/v1/rpc/approve_customer_deposit",{method:"POST",headers,body:JSON.stringify({p_deposit_id:depositId,p_admin_id:user.id})});
    if(!r.ok)return res.status(409).json({error:"Deposit cannot be approved"});
    return res.status(200).json({approved:true});
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(503).json({
      error: "Server configuration incomplete"
    });
  }

  const authorization = req.headers.authorization || "";

  let telegramId=null, customerId=null;
  if (authorization.startsWith("tma ") && botToken) {
    const user=verifyTelegramInitData(authorization.slice(4),botToken);
    if(user)telegramId=user.id;
  } else if(authorization.startsWith("Bearer ")){
    const response=await fetch(supabaseUrl.replace(/\/+$/,"")+"/auth/v1/user",{headers:{apikey:serviceKey,Authorization:authorization}});
    if(response.ok){const user=await response.json();customerId=user.id;}
  }
  if(!telegramId&&!customerId)return res.status(401).json({error:"Login required"});

  const body = req.body || {};
  const amount = Number(body.amount);
  const method = body.method;

  if (
    !Number.isFinite(amount) ||
    amount < 1 ||
    amount > 10000 ||
    typeof method !== "string" ||
    !METHODS.has(method)
  ) {
    return res.status(400).json({
      error: "Invalid deposit request"
    });
  }

  try {
    const baseUrl = supabaseUrl.replace(/\/+$/, "");

    const response = await fetch(
      `${baseUrl}/rest/v1/deposits`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          telegram_user_id: telegramId,
          customer_id: customerId,
          amount,
          method,
          status: "awaiting_payment"
        })
      }
    );

    const rows = await response.json().catch(() => null);

    if (!response.ok || !Array.isArray(rows) || !rows[0]?.id) {
      console.error("Create deposit failed", response.status);
      return res.status(502).json({
        error: "Could not create deposit request"
      });
    }

    return res.status(201).json({
      depositId: rows[0].id,
      amount: rows[0].amount,
      method: rows[0].method,
      status: rows[0].status,
      message: "Request created; payment is not verified."
    });
  } catch (error) {
    console.error("Create deposit request failed", error?.message);
    return res.status(502).json({
      error: "Deposit service temporarily unavailable"
    });
  }
}
