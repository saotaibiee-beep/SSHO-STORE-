import { verifyTelegramInitData } from "./_lib/telegram.js";

const TOKEN = "0x55d398326f99059fF775485246999027B3197955";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MIN_CONFIRMATIONS = 15;

function reply(res, status, body) {
  return res.status(status).json(body);
}

function sameAddress(a, b) {
  return typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase();
}

function addressFromTopic(topic) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic || "")) return null;
  return "0x" + topic.slice(-40);
}

function amountToUnits(value, decimals) {
  const s = String(value);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const [whole, fraction = ""] = s.split(".");
  if (fraction.length > decimals) return null;

  return BigInt(whole) * (10n ** BigInt(decimals)) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, { error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.BSCSCAN_API_KEY;
  const storeAddress = process.env.STORE_BEP20_ADDRESS;

  if (!botToken || !supabaseUrl || !serviceKey || !apiKey || !storeAddress) {
    return reply(res, 503, { error: "Server configuration incomplete" });
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(storeAddress)) {
    return reply(res, 503, { error: "Invalid store address configuration" });
  }

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("tma ")) {
    return reply(res, 401, { error: "Telegram authorization required" });
  }

  const user = verifyTelegramInitData(auth.slice(4), botToken);
  if (!user) {
    return reply(res, 401, { error: "Invalid Telegram session" });
  }

  const depositId = Number(req.body?.depositId);
  const txHash = String(req.body?.txHash || "").trim();

  if (!Number.isSafeInteger(depositId) || depositId <= 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return reply(res, 400, {
      error: "Valid depositId and txHash are required"
    });
  }

  const base = supabaseUrl.replace(/\/+$/, "");
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

  try {
    const depositUrl =
      `${base}/rest/v1/deposits?id=eq.${depositId}` +
      `&telegram_user_id=eq.${encodeURIComponent(user.id)}` +
      `&method=eq.USDT%20BEP20&select=id,amount,status,payment_reference`;

    const depositResponse = await fetch(depositUrl, { headers });
    const deposits = await depositResponse.json();

    if (!depositResponse.ok) {
      return reply(res, 502, { error: "Could not load deposit request" });
    }

    const deposit = Array.isArray(deposits) ? deposits[0] : null;
    if (!deposit) {
      return reply(res, 404, { error: "Deposit request not found" });
    }

    if (!["awaiting_payment", "pending_verification"].includes(deposit.status)) {
      return reply(res, 409, { error: "Deposit cannot be verified in this status" });
    }

    if (deposit.payment_reference &&
        deposit.payment_reference.toLowerCase() !== txHash.toLowerCase()) {
      return reply(res, 409, { error: "Another transaction is attached to this request" });
    }

    const duplicateUrl =
      `${base}/rest/v1/deposits?payment_reference=ilike.${encodeURIComponent(txHash)}` +
      `&id=neq.${depositId}&select=id&limit=1`;

    const duplicateResponse = await fetch(duplicateUrl, { headers });
    const duplicates = await duplicateResponse.json();

    if (!duplicateResponse.ok) {
      return reply(res, 502, { error: "Could not check transaction reuse" });
    }

    if (Array.isArray(duplicates) && duplicates.length) {
      return reply(res, 409, { error: "Transaction hash already submitted" });
    }

    async function chainApi(params) {
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", "56");
  url.searchParams.set("apikey", apiKey);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Blockchain API HTTP error: ${response.status}`);
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error("Blockchain API returned invalid JSON");
  }

  if (data.error) {
    throw new Error(
      `Blockchain RPC error: ${String(data.error.message || "Unknown error")}`
    );
  }

  if (data.result === undefined || data.result === null) {
    throw new Error("Blockchain API returned no result");
  }

  if (
    typeof data.result === "string" &&
    /^(NOTOK|ERROR|INVALID API KEY)/i.test(data.result.trim())
  ) {
    throw new Error("Blockchain API returned an error result");
  }

  return data.result;
}

    const receipt = await chainApi({
      module: "proxy",
      action: "eth_getTransactionReceipt",
      txhash: txHash
    });

    if (!receipt || typeof receipt !== "object") {
      return reply(res, 422, {
        error: "Transaction not found or not yet mined"
      });
    }

    if (receipt.status !== "0x1") {
      return reply(res, 422, { error: "Transaction failed on-chain" });
    }

    const matchingLogs = (receipt.logs || []).filter(log =>
      sameAddress(log.address, TOKEN) &&
      Array.isArray(log.topics) &&
      log.topics.length >= 3 &&
      log.topics[0].toLowerCase() === TRANSFER_TOPIC &&
      sameAddress(addressFromTopic(log.topics[2]), storeAddress)
    );

    if (!matchingLogs.length) {
      return reply(res, 422, {
        error: "No matching token transfer to the store address"
      });
    }

    const tx = await chainApi({
      module: "proxy",
      action: "eth_getTransactionByHash",
      txhash: txHash
    });

    if (!tx || !tx.blockNumber) {
      return reply(res, 422, { error: "Transaction is not mined" });
    }

    const latest = await chainApi({
      module: "proxy",
      action: "eth_blockNumber"
    });

    const confirmations =
      Number(BigInt(latest) - BigInt(tx.blockNumber) + 1n);

    if (!Number.isFinite(confirmations) || confirmations < MIN_CONFIRMATIONS) {
      return reply(res, 202, {
        status: "awaiting_confirmations",
        confirmations: Math.max(0, confirmations),
        requiredConfirmations: MIN_CONFIRMATIONS,
        message: "Waiting for confirmations. No balance was added."
      });
    }

    const expected = amountToUnits(deposit.amount, 18);
    if (expected === null) {
      return reply(res, 500, { error: "Invalid requested amount" });
    }

    const exactMatch = matchingLogs.some(log => {
      try {
        return /^0x[0-9a-fA-F]+$/.test(log.data || "") &&
          BigInt(log.data) === expected;
      } catch {
        return false;
      }
    });

    if (!exactMatch) {
      return reply(res, 422, {
        error: "Transfer amount does not match the requested amount"
      });
    }

    // Store the transaction for review only.
    // This endpoint does not credit any balance.
    const updateUrl =
      `${base}/rest/v1/deposits?id=eq.${depositId}` +
      `&telegram_user_id=eq.${encodeURIComponent(user.id)}` +
      `&status=in.(awaiting_payment,pending_verification)`;

    const updateResponse = await fetch(updateUrl, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({
        payment_reference: txHash,
        status: "pending_verification",
        updated_at: new Date().toISOString()
      })
    });

    const updated = await updateResponse.json();

    if (!updateResponse.ok || !Array.isArray(updated) || !updated.length) {
  if (updateResponse.status === 409 ||
      updateResponse.status === 400) {
    return reply(res, 409, {
      error: "This transaction may already be linked to another deposit. No balance was added."
    });
  }

  console.error(
    "Deposit update failed:",
    updateResponse.status,
    JSON.stringify(updated).slice(0, 500)
  );

  return reply(res, 502, {
    error: "Could not record the transaction. No balance was added."
  });
}

    return reply(res, 200, {
      status: "pending_verification",
      confirmations,
      message: "Transfer checks passed. Manual review is still required; no balance was added."
    });
  } catch (error) {
    console.error("BEP20 verification error:", error?.message);
    return reply(res, 502, {
      error: "Verification service unavailable. No balance was added."
    });
  }
}
