// Production adapters: Cognito (account linking), DynamoDB, KMS, SQS and the Alexa
// service APIs. Kept thin so the voice logic in skill.js stays testable.
import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const JOB_TTL_DAYS = 30;

/** Resolves the linked account (Cognito user pool) from the Alexa access token. */
export function cognitoIdentity({ domain, fetchImpl = fetch, ttlMs = 10 * 60_000 }) {
  const cache = new Map();
  return {
    async userIdFrom(h) {
      const token = h.requestEnvelope.context?.System?.user?.accessToken;
      if (!token) return null;
      const key = sha256(token);
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) return hit.sub;
      const res = await fetchImpl(`https://${domain}/oauth2/userInfo`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1500),
      });
      if (res.status === 401) return null; // expired or revoked: ask to link again
      if (!res.ok) throw new Error(`Account service error (HTTP ${res.status}).`);
      const { sub } = await res.json();
      if (cache.size > 500) cache.clear();
      cache.set(key, { sub, expires: Date.now() + ttlMs });
      return sub;
    },
  };
}

/**
 * Users table (pk userId):
 *   {userId, ai: {provider, apiKeyEnc, models?: {fast, deep}}, timezone, preferredChannel?,
 *    contact?: {email?, phone?}, calendar?: {type: "icloud", username, appPasswordEnc}}
 * Jobs table (pk userId, sk "<createdAt>#<jobId>", TTL expiresAt):
 *   {userId, sk, jobId, topic, channel, destination?, status, createdAt, summary?, reportKey?, readAt?}
 */
export function dynamoStore({ usersTable, jobsTable, client = new DynamoDBClient({}) }) {
  const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  return {
    async getUser(userId) {
      return (await doc.send(new GetCommand({ TableName: usersTable, Key: { userId } }))).Item;
    },
    async saveModels(userId, models) {
      await doc.send(
        new UpdateCommand({
          TableName: usersTable,
          Key: { userId },
          UpdateExpression: "SET #ai.#models = :m",
          ExpressionAttributeNames: { "#ai": "ai", "#models": "models" },
          ExpressionAttributeValues: { ":m": models },
        })
      );
    },
    async saveChannelPreference(userId, channel) {
      await doc.send(
        new UpdateCommand({
          TableName: usersTable,
          Key: { userId },
          UpdateExpression: "SET preferredChannel = :c",
          ExpressionAttributeValues: { ":c": channel },
        })
      );
    },
    async createJob(job) {
      const expiresAt = Math.floor(Date.parse(job.createdAt) / 1000) + JOB_TTL_DAYS * 86_400;
      await doc.send(
        new PutCommand({
          TableName: jobsTable,
          Item: { ...job, sk: `${job.createdAt}#${job.jobId}`, expiresAt },
          ConditionExpression: "attribute_not_exists(sk)",
        })
      );
    },
    async recentJobs(userId, limit = 5) {
      const out = await doc.send(
        new QueryCommand({
          TableName: jobsTable,
          KeyConditionExpression: "userId = :u",
          ExpressionAttributeValues: { ":u": userId },
          ScanIndexForward: false,
          Limit: limit,
        })
      );
      return out.Items ?? [];
    },
    async markRead(userId, job) {
      await doc.send(
        new UpdateCommand({
          TableName: jobsTable,
          Key: { userId, sk: job.sk },
          UpdateExpression: "SET readAt = :t",
          ExpressionAttributeValues: { ":t": new Date().toISOString() },
        })
      );
    },
  };
}

/** Decrypts per-user secrets (API keys, iCloud app passwords) bound to the user's ID. */
export function kmsSecrets({ client = new KMSClient({}), ttlMs = 5 * 60_000 } = {}) {
  const cache = new Map();
  return {
    async decrypt(ciphertext, userId) {
      const key = sha256(`${userId}\0${ciphertext}`);
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;
      const out = await client.send(
        new DecryptCommand({ CiphertextBlob: Buffer.from(ciphertext, "base64"), EncryptionContext: { userId } })
      );
      const value = Buffer.from(out.Plaintext).toString("utf8");
      if (cache.size > 200) cache.clear();
      cache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
  };
}

export function sqsQueue({ queueUrl, client = new SQSClient({}) }) {
  return {
    async enqueue(message) {
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }));
    },
  };
}

async function readProfile(fn) {
  try {
    const value = await fn();
    return value ? { value } : { missing: true };
  } catch (e) {
    if (e?.statusCode === 403) return { denied: true };
    if (e?.statusCode === 204) return { missing: true };
    throw e;
  }
}

/** Contact data from the user's Amazon profile; read on demand, never stored (Alexa policy). */
export const alexaContacts = {
  email: (h) => readProfile(() => h.serviceClientFactory.getUpsServiceClient().getProfileEmail()),
  phone: (h) =>
    readProfile(async () => {
      const n = await h.serviceClientFactory.getUpsServiceClient().getProfileMobileNumber();
      return n?.phoneNumber ? `${n.countryCode ?? ""}${n.phoneNumber}`.replace(/[^\d+]/g, "") : undefined;
    }),
};

/** "Dame un segundo" while the agent works (counts toward Alexa's ~8 s budget). */
export async function alexaProgressive(h, speech) {
  await h.serviceClientFactory.getDirectiveServiceClient().enqueue({
    header: { requestId: h.requestEnvelope.request.requestId },
    directive: { type: "VoicePlayer.Speak", speech: `<speak>${speech}</speak>` },
  });
}
