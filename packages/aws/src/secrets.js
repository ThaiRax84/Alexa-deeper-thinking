// Per-user secrets (AI API keys, iCloud app passwords) are encrypted with AES-256-GCM.
// The master key lives in an SSM SecureString, which has no monthly cost (a KMS key
// costs about 1 USD per month). The user's ID is bound as additional authenticated
// data, so a ciphertext copied to another user's record cannot be decrypted.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function aesSecrets(masterKeyBase64) {
  const key = Buffer.from(String(masterKeyBase64 ?? ""), "base64");
  if (key.length !== 32) throw new Error("The master key must be 32 bytes, base64-encoded.");

  return {
    /** @returns {string} base64 of version | iv | tag | ciphertext */
    encrypt(plaintext, userId) {
      if (!userId) throw new Error("userId is required to encrypt a secret.");
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(userId, "utf8"));
      const data = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), data]).toString("base64");
    },

    async decrypt(ciphertext, userId) {
      const raw = Buffer.from(String(ciphertext ?? ""), "base64");
      if (raw.length < 1 + IV_BYTES + TAG_BYTES || raw[0] !== VERSION) throw new Error("Unreadable secret.");
      const iv = raw.subarray(1, 1 + IV_BYTES);
      const tag = raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(userId, "utf8"));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(raw.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("Unreadable secret.");
      }
    },
  };
}
