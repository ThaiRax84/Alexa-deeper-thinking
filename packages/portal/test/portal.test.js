import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "@deeper-thinking/core";
import { createApp } from "../src/app.js";
import { makeValidators } from "../src/validate.js";

const registry = loadRegistry();

function setup({ user = null } = {}) {
  const saved = {};
  const app = createApp({
    verifyToken: async (t) => (t === "good" ? "u1" : null),
    store: {
      getUser: async () => user,
      saveAi: async (id, ai) => (saved.ai = ai),
      saveCalendar: async (id, c) => (saved.calendar = c),
      removeCalendar: async () => (saved.calendarRemoved = true),
      savePreferences: async (id, p) => (saved.prefs = p),
      deleteUser: async (id) => (saved.deleted = id),
    },
    secrets: { encrypt: (plain, id) => `enc(${plain},${id})` },
    registry,
    validateAi: async (provider, key) => {
      if (key === "bad-key-1234") throw Object.assign(new Error(), { publicMessage: "rechazó la llave" });
      return { fast: "f-1", deep: "d-1" };
    },
    validateCalendar: async () => ({ calendars: 3 }),
    publicConfig: { cognitoDomain: "auth.example", clientId: "c1", providers: [] },
    assets: { "/": { type: "text/html", body: "<html>" } },
    csp: "default-src 'self'",
  });
  const call = (method, path, body, token = "good") =>
    app({ method, path, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  const data = (res) => JSON.parse(res.body);
  return { call, data, saved };
}

test("API routes require a valid session", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/api/me", null, "bad")).statusCode, 401);
});

test("public config and the page do not need a session", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/api/config", null, "")).statusCode, 200);
  const page = await call("GET", "/", null, "");
  assert.equal(page.headers["content-security-policy"], "default-src 'self'");
});

test("saving the AI key validates it, encrypts it per user and stores the models", async () => {
  const { call, data, saved } = setup();
  const res = await call("PUT", "/api/ai", { provider: "openai", apiKey: "sk-good-key-123" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(data(res).models, { fast: "f-1", deep: "d-1" });
  assert.deepEqual(saved.ai, { provider: "openai", apiKeyEnc: "enc(sk-good-key-123,u1)", models: { fast: "f-1", deep: "d-1" } });
});

test("a rejected key or unknown company is explained and nothing is saved", async () => {
  const { call, data, saved } = setup();
  const bad = await call("PUT", "/api/ai", { provider: "openai", apiKey: "bad-key-1234" });
  assert.equal(bad.statusCode, 400);
  assert.match(data(bad).error, /rechazó la llave/);
  assert.equal((await call("PUT", "/api/ai", { provider: "acme", apiKey: "x".repeat(20) })).statusCode, 400);
  assert.equal(saved.ai, undefined);
});

test("the API key is never returned to the browser", async () => {
  const { call } = setup({ user: { ai: { provider: "google", apiKeyEnc: "secret", models: { fast: "a", deep: "b" } }, calendar: { type: "icloud", username: "a@b.mx", appPasswordEnc: "secret" } } });
  const res = await call("GET", "/api/me");
  assert.ok(!res.body.includes("secret"));
  assert.match(res.body, /Google Gemini/);
});

test("calendar credentials are checked and the app password is encrypted", async () => {
  const { call, data, saved } = setup();
  assert.equal((await call("PUT", "/api/calendar", { username: "a@b.mx", appPassword: "1234" })).statusCode, 400);
  const res = await call("PUT", "/api/calendar", { username: "a@b.mx", appPassword: "abcd-efgh-ijkl-mnop" });
  assert.equal(data(res).calendars, 3);
  assert.equal(saved.calendar.appPasswordEnc, "enc(abcd-efgh-ijkl-mnop,u1)");
});

test("preferences are validated", async () => {
  const { call, saved } = setup();
  assert.equal((await call("PUT", "/api/preferences", { timezone: "Mars/Base" })).statusCode, 400);
  assert.equal((await call("PUT", "/api/preferences", { preferredChannel: "fax" })).statusCode, 400);
  assert.equal((await call("PUT", "/api/preferences", { phone: "123" })).statusCode, 400);
  const ok = await call("PUT", "/api/preferences", {
    timezone: "America/Cancun",
    preferredChannel: "whatsapp",
    email: "",
    phone: "+52 (55) 1234-5678",
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(saved.prefs, { timezone: "America/Cancun", preferredChannel: "whatsapp", contact: { phone: "+525512345678" } });
});

test("users can delete their data", async () => {
  const { call, saved } = setup();
  await call("DELETE", "/api/me");
  assert.equal(saved.deleted, "u1");
});

test("malformed JSON is rejected", async () => {
  const { data } = setup();
  const app = createApp({ verifyToken: async () => "u1", registry, assets: {} });
  const res = await app({ method: "PUT", path: "/api/ai", headers: { authorization: "Bearer x" }, body: "{nope" });
  assert.equal(res.statusCode, 400);
  assert.match(data(res).error, /JSON/);
});

test("the AI validator turns provider errors into user messages", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "", json: async () => ({}) });
  const { validateAi } = makeValidators({ registry, fetchImpl });
  await assert.rejects(validateAi("anthropic", "k"), (e) => /Anthropic rechazó la llave/.test(e.publicMessage));

  const models = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "x-mini", created: 1 }] }) });
  const v2 = makeValidators({ registry, fetchImpl: models });
  await assert.rejects(v2.validateAi("openai", "k"), (e) => /no tiene acceso/.test(e.publicMessage));
});

test("the calendar validator closes the connection and reports iCloud rejections", async () => {
  let closed = 0;
  const connect = async () => ({
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "Could not sign in" }] }),
    close: async () => closed++,
  });
  const { validateCalendar } = makeValidators({ registry, connect });
  await assert.rejects(validateCalendar({}), (e) => /iCloud rechazó/.test(e.publicMessage));
  assert.equal(closed, 1);
});
