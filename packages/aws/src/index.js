import { createHash } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

export { aesSecrets } from "./secrets.js";
export { loadSsmConfig } from "./config.js";
export { dynamoStore, jobSk } from "./store.js";
export { s3Reports, reportKey } from "./reports.js";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function sqsQueue({ queueUrl, client = new SQSClient({}) }) {
  return {
    async enqueue(message) {
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }));
    },
  };
}

/** Resolves the linked account (Cognito sub) from an OAuth access token. */
export function cognitoIdentity({ domain, fetchImpl = fetch, ttlMs = 10 * 60_000 }) {
  const cache = new Map();
  return {
    async userIdFromToken(token) {
      if (!token) return null;
      const key = sha256(token);
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) return hit.sub;
      const res = await fetchImpl(`https://${domain}/oauth2/userInfo`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1500),
      });
      if (res.status === 401) return null; // expired or revoked
      if (!res.ok) throw new Error(`Account service error (HTTP ${res.status}).`);
      const { sub } = await res.json();
      if (cache.size > 500) cache.clear();
      cache.set(key, { sub, expires: Date.now() + ttlMs });
      return sub;
    },
  };
}
