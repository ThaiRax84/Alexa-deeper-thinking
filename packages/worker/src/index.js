// Lambda entry point: SQS-triggered deep research worker.
import {
  ToolHub,
  createProvider,
  loadRegistry,
  readPageTool,
  resolveModels,
  runDeepResearch,
  webSearchTool,
} from "@deeper-thinking/core";
import { aesSecrets, dynamoStore, loadSsmConfig, s3Reports } from "@deeper-thinking/aws";
import { processJob } from "./worker.js";
import { sesEmail, whatsAppCloud } from "./delivery.js";

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`Missing environment variable ${name}`);
  return env[name];
};

let depsPromise;

async function createDeps() {
  // Operator secrets: master-key (required), search-api-key, whatsapp-token (optional).
  const config = await loadSsmConfig(required("CONFIG_PATH"));
  const registry = loadRegistry(env.MODEL_REGISTRY_JSON ? JSON.parse(env.MODEL_REGISTRY_JSON) : {});
  const secrets = aesSecrets(config["master-key"]);
  const store = dynamoStore({ usersTable: required("USERS_TABLE"), jobsTable: required("JOBS_TABLE") });
  const searchKey = config["search-api-key"];

  return {
    store,
    reports: s3Reports({ bucket: required("REPORTS_BUCKET") }),
    maxAttempts: 3,
    email: env.EMAIL_FROM ? sesEmail({ from: env.EMAIL_FROM }) : undefined,
    whatsapp:
      config["whatsapp-token"] && env.WHATSAPP_PHONE_NUMBER_ID
        ? whatsAppCloud({
            token: config["whatsapp-token"],
            phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
            template: env.WHATSAPP_TEMPLATE || undefined,
            language: env.WHATSAPP_LANGUAGE || undefined,
            apiVersion: env.WHATSAPP_API_VERSION || undefined,
          })
        : undefined,

    async research({ user, topic }) {
      const apiKey = await secrets.decrypt(user.ai.apiKeyEnc, user.userId);
      const provider = createProvider(registry, user.ai.provider, apiKey);
      let models = user.ai.models;
      if (!models?.deep) {
        models = resolveModels(registry, user.ai.provider, await provider.listModels());
        await store.saveModels(user.userId, models);
      }
      const tools = new ToolHub();
      if (searchKey) {
        tools.addLocal(webSearchTool({ apiKey: searchKey, depth: "advanced" }));
        tools.addLocal(readPageTool({ apiKey: searchKey }));
      }
      return runDeepResearch({
        provider,
        model: models.deep,
        topic,
        tools,
        timezone: user.timezone || "America/Mexico_City",
        deadlineMs: Number(env.RESEARCH_DEADLINE_MS ?? 12 * 60_000),
      });
    },
  };
}

export async function handler(event) {
  depsPromise ??= createDeps().catch((e) => {
    depsPromise = undefined;
    throw e;
  });
  const deps = await depsPromise;
  const batchItemFailures = [];
  for (const record of event.Records ?? []) {
    try {
      const outcome = await processJob(deps, JSON.parse(record.body));
      console.log(JSON.stringify({ level: "info", messageId: record.messageId, outcome }));
    } catch (e) {
      // Only the error type and message: never job contents or user data.
      console.error(JSON.stringify({ level: "error", messageId: record.messageId, name: e?.name, message: e?.message }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
