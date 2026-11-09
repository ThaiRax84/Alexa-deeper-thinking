// Operator secrets (master key, search key, WhatsApp token) are read once per cold
// start from SSM Parameter Store under one path, e.g. /deeper-thinking/master-key.
import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

let cached;

/** @returns {Promise<Record<string, string>>} keyed by the last path segment */
export function loadSsmConfig(path, { client = new SSMClient({}) } = {}) {
  cached ??= (async () => {
    const out = {};
    let NextToken;
    do {
      const page = await client.send(
        new GetParametersByPathCommand({ Path: path, Recursive: true, WithDecryption: true, NextToken })
      );
      for (const p of page.Parameters ?? []) out[p.Name.split("/").at(-1)] = p.Value;
      NextToken = page.NextToken;
    } while (NextToken);
    return out;
  })().catch((e) => {
    cached = undefined;
    throw e;
  });
  return cached;
}
