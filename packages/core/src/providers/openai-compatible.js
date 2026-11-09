// Adapter for OpenAI-compatible Chat Completions APIs (OpenAI, Google Gemini's
// OpenAI endpoint, and any other provider that speaks the same protocol).
import { getJson, postJson } from "./http.js";

const parseArgs = (s) => {
  if (s && typeof s === "object") return s;
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

/** Converts the internal message format (see ../messages.js) to Chat Completions messages. */
export function toOpenAIMessages(system, messages) {
  const out = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.text || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}

export function openAICompatibleProvider({ apiKey, baseUrl, maxTokensParam = "max_tokens", fetchImpl = fetch }) {
  if (!baseUrl) throw new Error("baseUrl is required for an OpenAI-compatible provider.");
  const base = baseUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  return {
    api: "openai-compatible",

    async complete({ model, system, messages, tools = [], maxTokens = 1024, signal }) {
      const body = { model, messages: toOpenAIMessages(system, messages), [maxTokensParam]: maxTokens };
      if (tools.length) {
        body.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }));
      }
      const data = await postJson(fetchImpl, `${base}/chat/completions`, headers, body, signal);
      const msg = data.choices?.[0]?.message ?? {};
      return {
        text: (typeof msg.content === "string" ? msg.content : "").trim(),
        toolCalls: (msg.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function?.name,
          args: parseArgs(c.function?.arguments),
        })),
      };
    },

    async listModels({ signal } = {}) {
      const data = await getJson(fetchImpl, `${base}/models`, headers, signal);
      return (data.data ?? []).map((m) => ({ id: String(m.id).replace(/^models\//, ""), created: m.created }));
    },
  };
}
