import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "@deeper-thinking/core";
import { buildSkill } from "../lambda/skill.js";

const SKILL_ID = "amzn1.ask.skill.test";

function envelope(request, { attributes = {}, accessToken = "token" } = {}) {
  const system = { application: { applicationId: SKILL_ID }, user: { userId: "alexa-user", accessToken } };
  return {
    version: "1.0",
    session: { new: false, sessionId: "s1", application: system.application, user: system.user, attributes },
    context: { System: { ...system, apiEndpoint: "https://api.amazonalexa.com", apiAccessToken: "x" } },
    request: { requestId: "r1", timestamp: new Date().toISOString(), locale: "es-MX", ...request },
  };
}

const intent = (name, slots = {}) => ({ type: "IntentRequest", intent: { name, confirmationStatus: "NONE", slots } });
const query = (text) => intent("AgentIntent", { query: { name: "query", value: text } });
const canal = (id) =>
  intent("ChannelIntent", {
    canal: {
      name: "canal",
      value: id,
      resolutions: { resolutionsPerAuthority: [{ status: { code: "ER_SUCCESS_MATCH" }, values: [{ value: { id, name: id } }] }] },
    },
  });

const USER = { userId: "u1", ai: { provider: "anthropic", apiKeyEnc: "enc", models: { fast: "f", deep: "d" } } };

function setup({ user = USER, agentResult = { status: "done", speech: "Hola." }, contacts = {}, linked = true } = {}) {
  const calls = { jobs: [], queued: [], prefs: [], pending: [], read: [] };
  const deps = {
    skillId: SKILL_ID,
    portalUrl: "https://portal.example",
    identity: { userIdFrom: async () => (linked ? user?.userId ?? "u1" : null) },
    store: {
      getUser: async () => user,
      saveChannelPreference: async (_, c) => calls.prefs.push(c),
      createJob: async (j) => calls.jobs.push(j),
      recentJobs: async () => calls.recent ?? [],
      markRead: async (_, j) => calls.read.push(j.jobId),
    },
    queue: { enqueue: async (m) => calls.queued.push(m) },
    contacts: {
      email: async () => contacts.email ?? { value: "maximo@example.com" },
      phone: async () => contacts.phone ?? { value: "+525512345678" },
    },
    progressive: async () => {},
    newId: () => "job-1",
    now: () => new Date("2026-11-09T19:00:00Z"),
    agent: {
      run: async () => (typeof agentResult === "function" ? agentResult() : agentResult),
      executePending: async ({ pending }) => {
        calls.pending.push(pending);
        return "Listo, lo borré.";
      },
    },
  };
  return { skill: buildSkill(deps), calls };
}

const speech = (res) => res.response.outputSpeech?.ssml?.replace(/<\/?speak>/g, "");
const ended = (res) => res.response.shouldEndSession === true;

test("an unlinked user gets a link-account card", async () => {
  const { skill } = setup({ linked: false });
  const res = await skill.invoke(envelope(query("hola"), { accessToken: undefined }));
  assert.match(speech(res), /vincula tu cuenta/);
  assert.equal(res.response.card.type, "LinkAccount");
});

test("a linked user without AI provider is sent to the portal", async () => {
  const { skill } = setup({ user: { userId: "u1", ai: {} } });
  const res = await skill.invoke(envelope(query("hola")));
  assert.match(speech(res), /portal/);
  assert.equal(res.response.card.content, "https://portal.example");
});

test("a quick answer is spoken and the session ends", async () => {
  const { skill } = setup({ agentResult: { status: "done", speech: "**Hoy** hace sol & calor." } });
  const res = await skill.invoke(envelope(query("qué clima hace")));
  assert.equal(speech(res), "Hoy hace sol &amp; calor.");
  assert.ok(ended(res));
});

test("a destructive action asks first and only runs after yes", async () => {
  const pending = { name: "delete_event", args: { url: "https://p1.icloud.com/a.ics" } };
  const { skill, calls } = setup({
    agentResult: { status: "needs_confirmation", pending, prompt: "¿Borro Dentista del jueves?" },
  });
  const asked = await skill.invoke(envelope(query("borra dentista")));
  assert.equal(speech(asked), "¿Borro Dentista del jueves?");
  assert.equal(asked.sessionAttributes.state, "confirm_action");
  assert.equal(calls.pending.length, 0);

  const yes = await skill.invoke(envelope(intent("AMAZON.YesIntent"), { attributes: asked.sessionAttributes }));
  assert.equal(speech(yes), "Listo, lo borré.");
  assert.deepEqual(calls.pending, [pending]);
});

test("saying no to a destructive action changes nothing", async () => {
  const { skill, calls } = setup();
  const attrs = { state: "confirm_action", pending: { name: "delete_event", args: {} } };
  const res = await skill.invoke(envelope(intent("AMAZON.NoIntent"), { attributes: attrs }));
  assert.match(speech(res), /no hice ningún cambio/);
  assert.equal(calls.pending.length, 0);
});

test("long research asks for the delivery channel, then queues the job", async () => {
  const { skill, calls } = setup({ agentResult: { status: "long", topic: "Tarifas de GPS en México" } });
  const asked = await skill.invoke(envelope(query("investiga tarifas de GPS")));
  assert.match(speech(asked), /WhatsApp o por correo/);
  assert.equal(asked.sessionAttributes.topic, "Tarifas de GPS en México");

  const chosen = await skill.invoke(envelope(canal("whatsapp"), { attributes: asked.sessionAttributes }));
  assert.match(speech(chosen), /te lo mando por WhatsApp/);
  assert.equal(calls.jobs[0].destination, "+525512345678");
  assert.equal(calls.jobs[0].channel, "whatsapp");
  assert.deepEqual(calls.queued, [{ userId: "u1", jobId: "job-1", createdAt: "2026-11-09T19:00:00.000Z" }]);
  assert.deepEqual(calls.prefs, ["whatsapp"]);
});

test("a remembered channel is offered and accepted with yes", async () => {
  const { skill, calls } = setup({
    user: { ...USER, preferredChannel: "correo" },
    agentResult: { status: "timeout", topic: "algo largo" },
  });
  const asked = await skill.invoke(envelope(query("investiga algo largo")));
  assert.match(speech(asked), /más de lo normal.*por correo, como siempre/);
  const yes = await skill.invoke(envelope(intent("AMAZON.YesIntent"), { attributes: asked.sessionAttributes }));
  assert.match(speech(yes), /por correo/);
  assert.equal(calls.jobs[0].destination, "maximo@example.com");
  assert.deepEqual(calls.prefs, []);
});

test("missing contact permission shows a consent card and offers voice", async () => {
  const { skill, calls } = setup({ contacts: { email: { denied: true } } });
  const attrs = { state: "choose_channel", topic: "x" };
  const res = await skill.invoke(envelope(canal("correo"), { attributes: attrs }));
  assert.equal(res.response.card.type, "AskForPermissionsConsent");
  assert.deepEqual(res.response.card.permissions, ["alexa::profile:email:read"]);
  assert.equal(res.sessionAttributes.suggested, "voz");
  assert.equal(calls.jobs.length, 0);
});

test("results are read once and marked as read", async () => {
  const { skill, calls } = setup();
  calls.recent = [
    { jobId: "j2", status: "running", topic: "otro" },
    { jobId: "j1", status: "done", topic: "paneles solares", summary: "Convienen en casas con mucho sol.", channel: "correo" },
  ];
  const res = await skill.invoke(envelope(intent("ResultsIntent")));
  assert.match(speech(res), /Sobre paneles solares: Convienen.*te lo mandé por correo/);
  assert.deepEqual(calls.read, ["j1"]);
});

test("a rejected API key is explained in plain words", async () => {
  const { skill } = setup({
    agentResult: () => {
      throw new ProviderError("auth", "HTTP 401", 401);
    },
  });
  const res = await skill.invoke(envelope(query("hola")));
  assert.match(speech(res), /rechazó tu llave de API/);
});
