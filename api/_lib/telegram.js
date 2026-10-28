
import crypto from "node:crypto";

const MAX_AGE_SECONDS = 3600;

export function verifyTelegramInitData(initData, botToken) {
  if (
    typeof initData !== "string" ||
    !initData ||
    initData.length > 10_000 ||
    typeof botToken !== "string" ||
    !botToken
  ) {
    return null;
  }

  let params;

  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hashes = params.getAll("hash");
  const authDates = params.getAll("auth_date");
  const users = params.getAll("user");

  if (
    hashes.length !== 1 ||
    authDates.length !== 1 ||
    users.length !== 1 ||
    !/^[a-f0-9]{64}$/i.test(hashes[0])
  ) {
    return null;
  }

  const authDate = Number(authDates[0]);
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isSafeInteger(authDate) ||
    authDate > now + 30 ||
    now - authDate > MAX_AGE_SECONDS
  ) {
    return null;
  }

  const entries = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b));

  const dataCheckString = entries
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest();

  const receivedHash = Buffer.from(hashes[0], "hex");

  if (
    receivedHash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(receivedHash, expectedHash)
  ) {
    return null;
  }

  try {
    const user = JSON.parse(users[0]);

    if (
      !user ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0
    ) {
      return null;
    }

    return {
      id: user.id,
      first_name:
        typeof user.first_name === "string"
          ? user.first_name
          : "",
      username:
        typeof user.username === "string"
          ? user.username
          : null,
      auth_date: authDate
    };
  } catch {
    return null;
  }
}
