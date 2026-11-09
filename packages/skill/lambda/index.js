// Lambda entry point for the Alexa skill.
import { randomUUID } from "node:crypto";
import { CalendarPool, loadRegistry } from "@deeper-thinking/core";
import { buildSkill } from "./skill.js";
import { createAgentService } from "./agentService.js";
import {
  alexaContacts,
  alexaProgressive,
  cognitoIdentity,
  dynamoStore,
  kmsSecrets,
  sqsQueue,
} from "./adapters.js";

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`Missing environment variable ${name}`);
  return env[name];
};

const registry = loadRegistry(env.MODEL_REGISTRY_JSON ? JSON.parse(env.MODEL_REGISTRY_JSON) : {});
const store = dynamoStore({ usersTable: required("USERS_TABLE"), jobsTable: required("JOBS_TABLE") });
const secrets = kmsSecrets();

const skill = buildSkill({
  skillId: env.SKILL_ID,
  portalUrl: required("PORTAL_URL"),
  identity: cognitoIdentity({ domain: required("COGNITO_DOMAIN") }),
  store,
  queue: sqsQueue({ queueUrl: required("JOBS_QUEUE_URL") }),
  contacts: alexaContacts,
  progressive: alexaProgressive,
  newId: randomUUID,
  agent: createAgentService({
    registry,
    secrets,
    store,
    calendarPool: new CalendarPool(),
    searchApiKey: env.SEARCH_API_KEY,
    deadlineMs: Number(env.AGENT_DEADLINE_MS ?? 6000),
  }),
});

export const handler = (event, context) => skill.invoke(event, context);
