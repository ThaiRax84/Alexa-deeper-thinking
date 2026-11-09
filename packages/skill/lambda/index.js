// Lambda entry point for the Alexa skill.
import { randomUUID } from "node:crypto";
import { CalendarPool, loadRegistry } from "@deeper-thinking/core";
import { aesSecrets, cognitoIdentity, dynamoStore, loadSsmConfig, sqsQueue } from "@deeper-thinking/aws";
import { buildSkill } from "./skill.js";
import { createAgentService } from "./agentService.js";
import { accessTokenOf, alexaContacts, alexaProgressive } from "./adapters.js";

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`Missing environment variable ${name}`);
  return env[name];
};

let skillPromise;

async function createSkill() {
  // Operator secrets: master-key (required), search-api-key (optional).
  const config = await loadSsmConfig(required("CONFIG_PATH"));
  const registry = loadRegistry(env.MODEL_REGISTRY_JSON ? JSON.parse(env.MODEL_REGISTRY_JSON) : {});
  const store = dynamoStore({ usersTable: required("USERS_TABLE"), jobsTable: required("JOBS_TABLE") });
  const identity = cognitoIdentity({ domain: required("COGNITO_DOMAIN") });

  return buildSkill({
    skillId: env.SKILL_ID,
    portalUrl: required("PORTAL_URL"),
    identity: { userIdFrom: (h) => identity.userIdFromToken(accessTokenOf(h)) },
    store,
    queue: sqsQueue({ queueUrl: required("JOBS_QUEUE_URL") }),
    contacts: alexaContacts,
    progressive: alexaProgressive,
    newId: randomUUID,
    agent: createAgentService({
      registry,
      secrets: aesSecrets(config["master-key"]),
      store,
      calendarPool: new CalendarPool(),
      searchApiKey: config["search-api-key"],
      deadlineMs: Number(env.AGENT_DEADLINE_MS ?? 6000),
    }),
  });
}

export async function handler(event, context) {
  skillPromise ??= createSkill().catch((e) => {
    skillPromise = undefined;
    throw e;
  });
  return (await skillPromise).invoke(event, context);
}
