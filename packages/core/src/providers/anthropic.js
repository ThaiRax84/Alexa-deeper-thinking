// Adapter for the Anthropic Messages API.
import { getJson, postJson } from "./http.js";

const API_VERSION = "2023-06-01";

/** Converts the internal message format (see ../messages.js) to Anthropic messages. */
export function toAnthropicMessages(messages) {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "assistant") {
      const content = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      return { role: "assistant", content };
    }
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.content,
        is_error: Boolean(r.isError),
      })),
    };
  });
}

export function anthropicProvider({ apiKey, baseUrl = "https://api.anthropic.com", fetchImpl = fetch }) {
  const headers = { "x-api-key": apiKey, "anthropic-version": API_VERSION, "content-type": "application/json" };

  return {
    api: "anthropic",

    async complete({ model, system, messages, tools = [], maxTokens = 1024, signal }) {
      const body = { model, max_tokens: maxTokens, system, messages: toAnthropicMessages(messages) };
      if (tools.length) {
        body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      }
      const data = await postJson(fetchImpl, `${baseUrl}/v1/messages`, headers, body, signal);
      const blocks = data.content ?? [];
      return {
        text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim(),
        toolCalls: blocks
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
      };
    },

    async listModels({ signal } = {}) {
      const out = [];
      let after;
      for (let page = 0; page < 10; page++) {
        const qs = new URLSearchParams({ limit: "1000", ...(after ? { after_id: after } : {}) });
        const data = await getJson(fetchImpl, `${baseUrl}/v1/models?${qs}`, headers, signal);
        for (const m of data.data ?? []) {
          out.push({ id: m.id, created: m.created_at ? Date.parse(m.created_at) / 1000 : undefined });
        }
        if (!data.has_more) break;
        after = data.last_id;
      }
      return out;
    },
  };
}
