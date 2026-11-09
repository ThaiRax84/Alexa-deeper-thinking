// DynamoDB storage.
//
// Users (pk userId = Cognito sub):
//   {userId, ai: {provider, apiKeyEnc, models: {fast, deep}}, timezone, preferredChannel?,
//    contact?: {email?, phone?}, calendar?: {type: "icloud", username, appPasswordEnc}, updatedAt}
// Jobs (pk userId, sk "<createdAt>#<jobId>", TTL expiresAt):
//   {userId, sk, jobId, topic, channel, destination?, status: queued|running|done|failed,
//    attempts, createdAt, summary?, reportKey?, error?, readAt?, finishedAt?}
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const JOB_TTL_DAYS = 30;
export const jobSk = (job) => `${job.createdAt}#${job.jobId}`;

export function dynamoStore({ usersTable, jobsTable, client = new DynamoDBClient({}), now = () => new Date() }) {
  const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  const iso = () => now().toISOString();

  const setUser = (userId, fields, remove = []) => {
    const names = {};
    const values = { ":t": iso() };
    const sets = ["updatedAt = :t"];
    Object.entries(fields).forEach(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      sets.push(`#f${i} = :v${i}`);
    });
    remove.forEach((k, i) => (names[`#r${i}`] = k));
    const removeExpr = remove.length ? ` REMOVE ${remove.map((_, i) => `#r${i}`).join(", ")}` : "";
    return doc.send(
      new UpdateCommand({
        TableName: usersTable,
        Key: { userId },
        UpdateExpression: `SET ${sets.join(", ")}${removeExpr}`,
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
      })
    );
  };

  return {
    // ---- users ----
    async getUser(userId) {
      return (await doc.send(new GetCommand({ TableName: usersTable, Key: { userId } }))).Item;
    },
    saveAi: (userId, ai) => setUser(userId, { ai }),
    saveModels: (userId, models) =>
      doc.send(
        new UpdateCommand({
          TableName: usersTable,
          Key: { userId },
          UpdateExpression: "SET #ai.#models = :m",
          ExpressionAttributeNames: { "#ai": "ai", "#models": "models" },
          ExpressionAttributeValues: { ":m": models },
        })
      ),
    saveCalendar: (userId, calendar) => setUser(userId, { calendar }),
    removeCalendar: (userId) => setUser(userId, {}, ["calendar"]),
    savePreferences: (userId, { timezone, preferredChannel, contact }) =>
      setUser(
        userId,
        Object.fromEntries(Object.entries({ timezone, preferredChannel, contact }).filter(([, v]) => v !== undefined))
      ),
    saveChannelPreference: (userId, channel) => setUser(userId, { preferredChannel: channel }),

    /** Deletes the user and all of their jobs (account deletion). */
    async deleteUser(userId) {
      let ExclusiveStartKey;
      do {
        const page = await doc.send(
          new QueryCommand({
            TableName: jobsTable,
            KeyConditionExpression: "userId = :u",
            ExpressionAttributeValues: { ":u": userId },
            ProjectionExpression: "userId, sk",
            ExclusiveStartKey,
          })
        );
        const keys = page.Items ?? [];
        for (let i = 0; i < keys.length; i += 25) {
          await doc.send(
            new BatchWriteCommand({
              RequestItems: { [jobsTable]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) },
            })
          );
        }
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      await doc.send(new DeleteCommand({ TableName: usersTable, Key: { userId } }));
    },

    // ---- jobs ----
    async createJob(job) {
      const expiresAt = Math.floor(Date.parse(job.createdAt) / 1000) + JOB_TTL_DAYS * 86_400;
      await doc.send(
        new PutCommand({
          TableName: jobsTable,
          Item: { ...job, sk: jobSk(job), attempts: 0, expiresAt },
          ConditionExpression: "attribute_not_exists(sk)",
        })
      );
    },
    async getJob(userId, sk) {
      return (await doc.send(new GetCommand({ TableName: jobsTable, Key: { userId, sk } }))).Item;
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
          ExpressionAttributeValues: { ":t": iso() },
        })
      );
    },
    /** Moves a job to "running"; returns false if it is already finished (duplicate delivery). */
    async claimJob(userId, sk) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: jobsTable,
            Key: { userId, sk },
            UpdateExpression: "SET #s = :running, attempts = if_not_exists(attempts, :zero) + :one",
            ConditionExpression: "attribute_exists(sk) AND #s IN (:queued, :running)",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":running": "running", ":queued": "queued", ":zero": 0, ":one": 1 },
          })
        );
        return true;
      } catch (e) {
        if (e?.name === "ConditionalCheckFailedException") return false;
        throw e;
      }
    },
    /**
     * Marks a job done. The destination (email/phone) is removed once used.
     * deliveryError is set when the research finished but could not be sent, so the
     * user can still hear the summary by voice.
     */
    async completeJob(userId, sk, { summary, reportKey, deliveryError }) {
      await doc.send(
        new UpdateCommand({
          TableName: jobsTable,
          Key: { userId, sk },
          UpdateExpression:
            "SET #s = :done, summary = :summary, reportKey = :key, finishedAt = :t, deliveryError = :de REMOVE destination",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":done": "done",
            ":summary": summary,
            ":key": reportKey,
            ":t": iso(),
            ":de": deliveryError ? String(deliveryError).slice(0, 300) : null,
          },
        })
      );
    },
    async failJob(userId, sk, error) {
      await doc.send(
        new UpdateCommand({
          TableName: jobsTable,
          Key: { userId, sk },
          UpdateExpression: "SET #s = :failed, #e = :e, finishedAt = :t REMOVE destination",
          ExpressionAttributeNames: { "#s": "status", "#e": "error" },
          ExpressionAttributeValues: { ":failed": "failed", ":e": String(error).slice(0, 300), ":t": iso() },
        })
      );
    },
  };
}
