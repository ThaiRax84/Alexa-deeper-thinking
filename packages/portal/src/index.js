// Lambda entry point for the portal, served through a Lambda Function URL.
import { readFileSync } from "node:fs";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { listProviders, loadRegistry } from "@deeper-thinking/core";
import { aesSecrets, dynamoStore, loadSsmConfig } from "@deeper-thinking/aws";
import { createApp } from "./app.js";
import { makeValidators } from "./validate.js";

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`Missing environment variable ${name}`);
  return env[name];
};

const PUBLIC_DIR = new URL(env.PUBLIC_DIR ? `file://${env.PUBLIC_DIR}/` : "../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, PUBLIC_DIR), "utf8");

let appPromise;

async function createPortal() {
  // Operator config: master-key (secret) and portal-client-id (written by the stack).
  const config = await loadSsmConfig(required("CONFIG_PATH"));
  const registry = loadRegistry(env.MODEL_REGISTRY_JSON ? JSON.parse(env.MODEL_REGISTRY_JSON) : {});
  const clientId = config["portal-client-id"];
  const cognitoDomain = required("COGNITO_DOMAIN");
  const verifier = CognitoJwtVerifier.create({ userPoolId: required("USER_POOL_ID"), tokenUse: "access", clientId });

  const html = (name) => ({ type: "text/html; charset=utf-8", body: read(name) });
  return createApp({
    verifyToken: async (token) => {
      try {
        return (await verifier.verify(token)).sub;
      } catch {
        return null;
      }
    },
    store: dynamoStore({ usersTable: required("USERS_TABLE"), jobsTable: required("JOBS_TABLE") }),
    secrets: aesSecrets(config["master-key"]),
    registry,
    ...makeValidators({ registry }),
    publicConfig: { cognitoDomain, clientId, providers: listProviders(registry) },
    assets: {
      "/": html("index.html"),
      "/privacidad": html("privacidad.html"),
      "/terminos": html("terminos.html"),
      "/app.js": { type: "text/javascript; charset=utf-8", body: read("app.js") },
      "/styles.css": { type: "text/css; charset=utf-8", body: read("styles.css") },
    },
    csp: [
      "default-src 'self'",
      `connect-src 'self' https://${cognitoDomain}`,
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  });
}

/** Lambda Function URL event (payload format 2.0) → app request. */
export async function handler(event) {
  appPromise ??= createPortal().catch((e) => {
    appPromise = undefined;
    throw e;
  });
  const app = await appPromise;
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return app({ method: event.requestContext?.http?.method ?? "GET", path: event.rawPath || "/", headers, body });
}
