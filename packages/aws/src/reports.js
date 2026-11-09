// Research results ({topic, summary, report}), kept in S3 as JSON. The bucket
// expires them after 30 days. Saving before delivery lets a retry skip the research.
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export const reportKey = (userId, jobId) => `reports/${userId}/${jobId}.json`;

export function s3Reports({ bucket, client = new S3Client({}) }) {
  return {
    async put(key, result) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(result),
          ContentType: "application/json; charset=utf-8",
        })
      );
    },
    /** @returns {Promise<object|null>} */
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return JSON.parse(await out.Body.transformToString("utf-8"));
      } catch (e) {
        if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
  };
}
