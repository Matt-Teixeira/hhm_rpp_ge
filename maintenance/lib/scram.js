"use strict";
// SCRAM-SHA-256 (RFC 5802 / RFC 7677) verifier in PostgreSQL's stored format,
// so a password can be set without the plaintext ever reaching the server.
const crypto = require("crypto");

const hmac = (key, msg) => crypto.createHmac("sha256", key).update(msg).digest();

function scramKeys(password, salt, iterations) {
  const salted = crypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = hmac(salted, "Client Key");
  return {
    clientKey,
    storedKey: crypto.createHash("sha256").update(clientKey).digest(),
    serverKey: hmac(salted, "Server Key"),
  };
}

function scramVerifier(password, iterations = 4096, salt = crypto.randomBytes(16)) {
  const { storedKey, serverKey } = scramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

module.exports = { scramVerifier, scramKeys, hmac };
