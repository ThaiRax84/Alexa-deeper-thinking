import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider, loadRegistry, ProviderError } from "../src/index.js";
import { toAnthropicMessages } from "../src/providers/anthropic.js";
import { toOpenAIMessages } from "../src/providers/openai-compatible.js";

const registry = loadRegistry();

const history = [
  { role: "user", text: "agenda dentista" },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "add_event", args: { title: "Dentista" } }] },
  { role: "tool", results: [{ id: "c1", name: "add_event", content: "{\"ok\":true}", isError: false }] },
];

function fakeFetch(responseBody, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return {
      ok: status < 400,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  };
  return { impl, calls };
}

test("anthropic message conversion keeps tool_use / tool_result pairing", () => {
  const out = toAnthropicMessages(history);
  assert.equal(out[1].content[0].type, "tool_use");
  assert.equal(out[2].role, "user");
  assert.equal(out[2].content[0].tool_use_id, "c1");
});

test("openai message conversion adds system prompt and tool messages", () => {
  const out = toOpenAIMessages("sys", history);
  assert.deepEqual(out[0], { role: "system", content: "sys" });
  assert.equal(out[2].tool_calls[0].function.arguments, "{\"title\":\"Dentista\"}");
  assert.deepEqual(out[3], { role: "tool", tool_call_id: "c1", content: "{\"ok\":true}" });
});

test("anthropic adapter parses text and tool calls", async () => {
  const { impl, calls } = fakeFetch({
    content: [
      { type: "text", text: "Voy." },
      { type: "tool_use", id: "t1", name: "web_search", input: { query: "clima" } },
    ],
  });
  const p = createProvider(registry, "anthropic", "k-secret", { fetchImpl: impl });
  const res = await p.complete({ model: "m", system: "s", messages: [{ role: "user", text: "hola" }], tools: [] });
  assert.equal(res.text, "Voy.");
  assert.deepEqual(res.toolCalls, [{ id: "t1", name: "web_search", args: { query: "clima" } }]);
  assert.equal(calls[0].init.headers["x-api-key"], "k-secret");
});

test("openai adapter uses the provider's max-tokens parameter and parses tool calls", async () => {
  const { impl, calls } = fakeFetch({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "x", type: "function", function: { name: "list_calendars", arguments: "{}" } }],
        },
      },
    ],
  });
  const p = createProvider(registry, "openai", "k", { fetchImpl: impl });
  const res = await p.complete({ model: "m", system: "s", messages: [{ role: "user", text: "hola" }], maxTokens: 50 });
  assert.equal(calls[0].body.max_completion_tokens, 50);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.deepEqual(res.toolCalls, [{ id: "x", name: "list_calendars", args: {} }]);
});

test("gemini models are listed without the models/ prefix", async () => {
  const { impl } = fakeFetch({ data: [{ id: "models/gemini-3.8-flash" }] });
  const p = createProvider(registry, "google", "k", { fetchImpl: impl });
  assert.deepEqual(await p.listModels(), [{ id: "gemini-3.8-flash", created: undefined }]);
});

test("HTTP errors become typed ProviderErrors without leaking the key", async () => {
  const { impl } = fakeFetch({ error: "bad key" }, { status: 401 });
  const p = createProvider(registry, "anthropic", "sk-very-secret", { fetchImpl: impl });
  await assert.rejects(
    p.complete({ model: "m", system: "s", messages: [{ role: "user", text: "x" }] }),
    (e) => e instanceof ProviderError && e.kind === "auth" && !e.message.includes("sk-very-secret")
  );
});
