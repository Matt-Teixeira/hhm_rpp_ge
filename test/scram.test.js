"use strict";
// RFC 7677 §3 test vector: user "user", password "pencil".
const test = require("node:test");
const assert = require("node:assert");
const { scramKeys, scramVerifier, hmac } = require("../maintenance/lib/scram");

test("RFC 7677 vector: derived keys reproduce the published ClientProof and ServerSignature", () => {
  const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  const { clientKey, storedKey, serverKey } = scramKeys("pencil", salt, 4096);
  const nonce = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
  const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
  const clientSignature = hmac(storedKey, authMessage);
  const proof = Buffer.from(clientKey.map((b, i) => b ^ clientSignature[i]));
  assert.strictEqual(proof.toString("base64"), "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=");
  assert.strictEqual(hmac(serverKey, authMessage).toString("base64"), "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
});

test("verifier has PostgreSQL's stored format and a random salt", () => {
  const v = scramVerifier("pencil");
  assert.match(v, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
  assert.notStrictEqual(v, scramVerifier("pencil"));
});
