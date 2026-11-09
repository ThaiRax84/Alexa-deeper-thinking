import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, ToolHub, calendarQuickReplies, toSpeech, voiceSystemPrompt } from "../src/index.js";

/** A provider that replays scripted responses and records what it was sent. */
function scripted(...responses) {
  const seen = [];
  return {
    seen,
    async complete(req) {
      seen.push(structuredClone({ messages: req.messages, tools: req.tools.map((t) => t.name) }));
      const r = responses.shift();
      if (typeof r === "function") return r(req);
      return { text: "", toolCalls: [], ...r };
    },
  };
}

function hub() {
  const executed = [];
  const tools = new ToolHub()
    .addLocal({
      name: "web_search",
      description: "search",
      inputSchema: { type: "object" },
      run: async ({ query }) => ({ answer: `resultado de ${query}` }),
    })
    .addLocal({
      name: "add_event",
      description: "add",
      inputSchema: { type: "object" },
      run: async (args) => {
        executed.push(["add_event", args]);
        return { uid: "u1" };
      },
      quickReply: calendarQuickReplies("America/Mexico_City").add_event,
    })
    .addLocal({
      name: "delete_event",
      description: "delete",
      inputSchema: { type: "object" },
      destructive: true,
      run: async (args) => {
        executed.push(["delete_event", args]);
        return { deleted: args.url };
      },
    });
  return { tools, executed };
}

const base = { model: "m", system: "s", deadlineMs: 5000 };
const ask = (text) => [{ role: "user", text }];

test("answers directly when the model needs no tools", async () => {
  const { tools } = hub();
  const r = await runAgent({ ...base, provider: scripted({ text: "Hola." }), tools, messages: ask("hola") });
  assert.equal(r.status, "done");
  assert.equal(r.speech, "Hola.");
});

test("runs a tool, feeds the result back and returns the final answer", async () => {
  const { tools } = hub();
  const provider = scripted(
    { toolCalls: [{ id: "1", name: "web_search", args: { query: "clima" } }] },
    { text: "Hoy hace sol." }
  );
  const r = await runAgent({ ...base, provider, tools, messages: ask("¿clima?") });
  assert.equal(r.speech, "Hoy hace sol.");
  const toolMsg = provider.seen[1].messages.at(-1);
  assert.equal(toolMsg.role, "tool");
  assert.match(toolMsg.results[0].content, /resultado de clima/);
});

test("adding an event replies from a template, without a second model call", async () => {
  const { tools, executed } = hub();
  const provider = scripted({
    toolCalls: [
      { id: "1", name: "add_event", args: { title: "Dentista", start: "2026-11-12T17:00:00-06:00", end: "2026-11-12T18:00:00-06:00" } },
    ],
  });
  const r = await runAgent({ ...base, provider, tools, messages: ask("agenda dentista") });
  assert.equal(r.status, "done");
  assert.equal(r.speech, 'Listo, agregué "Dentista" el jueves 12 de noviembre a las 17:00.');
  assert.equal(provider.seen.length, 1);
  assert.equal(executed.length, 1);
});

test("destructive tools are never executed by the loop; they wait for confirmation", async () => {
  const { tools, executed } = hub();
  const provider = scripted({
    text: "¿Borro Dentista del jueves?",
    toolCalls: [{ id: "1", name: "delete_event", args: { url: "https://p1.icloud.com/x.ics" } }],
  });
  const r = await runAgent({ ...base, provider, tools, messages: ask("borra dentista") });
  assert.equal(r.status, "needs_confirmation");
  assert.equal(r.prompt, "¿Borro Dentista del jueves?");
  assert.deepEqual(r.pending, { name: "delete_event", args: { url: "https://p1.icloud.com/x.ics" } });
  assert.equal(executed.length, 0);

  const refused = await tools.call({ id: "2", ...r.pending });
  assert.equal(refused.isError, true);
  const done = await tools.executeConfirmed(r.pending);
  assert.equal(done.isError, false);
  assert.deepEqual(executed, [["delete_event", { url: "https://p1.icloud.com/x.ics" }]]);
});

test("hands off to deep research when the model asks for it", async () => {
  const { tools } = hub();
  const provider = scripted({
    toolCalls: [{ id: "1", name: "start_deep_research", args: { topic: "Comparar tarifas de GPS en México" } }],
  });
  const r = await runAgent({ ...base, provider, tools, messages: ask("investiga tarifas") });
  assert.deepEqual([r.status, r.topic], ["long", "Comparar tarifas de GPS en México"]);
  assert.ok(provider.seen[0].tools.includes("start_deep_research"));
});

test("a slow provider turns into a timeout with the user's request as topic", async () => {
  const { tools } = hub();
  const provider = {
    // A ref'd timer stands in for the pending HTTP request (AbortSignal.timeout timers are unref'd).
    complete: ({ signal }) =>
      new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 5000);
        signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(signal.reason);
        });
      }),
  };
  const r = await runAgent({ ...base, deadlineMs: 30, provider, tools, messages: ask("investiga algo largo") });
  assert.deepEqual([r.status, r.topic], ["timeout", "investiga algo largo"]);
});

test("unknown tools and tool failures are reported to the model, not thrown", async () => {
  const tools = new ToolHub().addLocal({
    name: "boom",
    description: "",
    inputSchema: {},
    run: async () => {
      throw new Error("falló");
    },
  });
  assert.deepEqual(await tools.call({ id: "1", name: "boom", args: {} }), {
    id: "1",
    name: "boom",
    content: "falló",
    isError: true,
  });
  assert.equal((await tools.call({ id: "2", name: "nope", args: {} })).isError, true);
});

test("speech output drops markdown and URLs and escapes XML", () => {
  assert.equal(
    toSpeech("## Hola\n- **uno** & [dos](https://x.com) <tres> https://y.com"),
    "Hola uno &amp; dos &lt;tres&gt;"
  );
});

test("the voice prompt includes the local date and calendar rules only when connected", () => {
  const p = voiceSystemPrompt({ now: new Date("2026-11-09T19:00:00Z"), timezone: "America/Mexico_City", hasCalendar: false });
  assert.match(p, /lunes 9 de noviembre de 2026, 13:00/);
  assert.match(p, /no ha conectado un calendario/);
});
