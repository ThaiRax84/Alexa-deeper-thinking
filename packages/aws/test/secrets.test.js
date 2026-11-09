import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { aesSecrets } from "../src/index.js";

const secrets = aesSecrets(randomBytes(32).toString("base64"));

test("round-trips a secret for the same user", async () => {
  const c = secrets.encrypt("sk-test-123", "user-a");
  assert.notEqual(c, "sk-test-123");
  assert.equal(await secrets.decrypt(c, "user-a"), "sk-test-123");
});

test("a ciphertext cannot be decrypted as another user", async () => {
  const c = secrets.encrypt("sk-test-123", "user-a");
  await assert.rejects(secrets.decrypt(c, "user-b"), /Unreadable secret/);
});

test("tampered ciphertexts are rejected", async () => {
  const raw = Buffer.from(secrets.encrypt("hola", "u"), "base64");
  raw[raw.length - 1] ^= 1;
  await assert.rejects(secrets.decrypt(raw.toString("base64"), "u"), /Unreadable secret/);
});

test("rejects a master key of the wrong size", () => {
  assert.throws(() => aesSecrets(randomBytes(16).toString("base64")), /32 bytes/);
});

test("each encryption uses a fresh IV", () => {
  assert.notEqual(secrets.encrypt("x", "u"), secrets.encrypt("x", "u"));
});
