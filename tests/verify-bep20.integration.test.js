import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.BSCSCAN_API_KEY = "test-chain-key";
const STORE = "0x" + "b".repeat(40);
process.env.STORE_BEP20_ADDRESS = STORE;

const TOKEN = "0x55d398326f99059fF775485246999027B3197955";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TX = "0x" + "a".repeat(64);
const USER_ID = 12345;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function telegramInitData() {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("user", JSON.stringify({ id: USER_ID, first_name: "Test" }));
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dataCheck).digest("hex"));
  return params.toString();
}
const topicAddress = (address) => "0x" + address.slice(2).toLowerCase().padStart(64, "0");
function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function setupFetch(opts = {}) {
  const state = {
    deposit: { id: 7, amount: "12.34", status: "awaiting_payment", payment_reference: null },
    duplicate: [],
    patchCalls: 0,
    patchStatus: opts.patchStatus ?? 200,
    patchBody: opts.patchBody,
    confirmations: opts.confirmations ?? 15,
    receiptStatus: opts.receiptStatus ?? "0x1",
    recipient: opts.recipient ?? STORE,
    token: opts.token ?? TOKEN,
    amount: opts.amount ?? "12.34",
    chainUnavailable: opts.chainUnavailable ?? false
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "supabase.test") {
      if (url.pathname.endsWith("/deposits") && (!init.method || init.method === "GET")) {
        if (url.searchParams.has("payment_reference")) return response(200, state.duplicate);
        return response(200, [{ ...state.deposit, telegram_user_id: USER_ID, method: "USDT BEP20" }]);
      }
      if (url.pathname.endsWith("/deposits") && init.method === "PATCH") {
        state.patchCalls++;
        if (state.patchStatus >= 400) return response(state.patchStatus, state.patchBody ?? { code: "23505", message: "duplicate key value violates unique constraint" });
        state.deposit = { ...state.deposit, ...JSON.parse(init.body) };
        return response(200, [state.deposit]);
      }
    }
    if (url.hostname === "api.etherscan.io") {
      const action = url.searchParams.get("action");
      if (state.chainUnavailable) return response(503, { error: "unavailable" });
      if (action === "eth_getTransactionReceipt") return response(200, { result: {
        status: state.receiptStatus,
        logs: [{ address: state.token, topics: [TRANSFER_TOPIC, topicAddress("0x" + "c".repeat(40)), topicAddress(state.recipient)], data: "0x" + (BigInt(Math.round(Number(state.amount) * 1e6)) * 10n ** 12n).toString(16) }]
      }});
      if (action === "eth_getTransactionByHash") return response(200, { result: { blockNumber: "0x64" } });
      if (action === "eth_blockNumber") return response(200, { result: "0x" + (100 + state.confirmations - 1).toString(16) });
    }
    throw new Error("Unexpected mocked request: " + url);
  };
  return state;
}
const { default: handler } = await import("../api/verify-bep20.js");
function call(body = { depositId: 7, txHash: TX }, initData = telegramInitData()) {
  const req = { method: "POST", headers: { authorization: "tma " + initData }, body };
  const res = {
    headers: {}, statusCode: 200, body: null,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  return handler(req, res).then(() => res);
}

test("REAL API HANDLER: valid mocked BEP20 transfer records pending review and never credits balance", async () => {
  const s = setupFetch();
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.status, "pending_verification");
  assert.equal(s.deposit.payment_reference, TX);
  assert.equal(s.deposit.status, "pending_verification");
  assert.equal(r.body.message.includes("no balance was added"), true);
});
test("REAL API HANDLER: rejects a mismatched transfer amount without writing", async () => {
  const s = setupFetch({ amount: "11.00" });
  const r = await call();
  assert.equal(r.statusCode, 422);
  assert.equal(s.patchCalls, 0);
});
test("REAL API HANDLER: waits below 15 confirmations without writing", async () => {
  const s = setupFetch({ confirmations: 14 });
  const r = await call();
  assert.equal(r.statusCode, 202);
  assert.equal(s.patchCalls, 0);
});
test("REAL API HANDLER: maps database unique-index conflict to HTTP 409, without claiming success", async () => {
  const s = setupFetch({ patchStatus: 409 });
  const r = await call();
  assert.equal(r.statusCode, 409);
  assert.equal(s.patchCalls, 1);
  assert.notEqual(r.body.status, "pending_verification");
});
test("REAL API HANDLER: rejects invalid transaction hash before calling services", async () => {
  const s = setupFetch();
  const r = await call({ depositId: 7, txHash: "bad" });
  assert.equal(r.statusCode, 400);
  assert.equal(s.patchCalls, 0);
});
