// The agent loop. Provider-agnostic and voice-agnostic: it receives a provider
// adapter, a model ID, a ToolHub and a deadline, and returns one of:
//
//   {status: "done", speech}                       answer ready to be spoken
//   {status: "needs_confirmation", pending, prompt} a destructive tool is waiting for a "yes"
//   {status: "long", topic}                        the model handed off to deep research
//   {status: "timeout", topic}                     the deadline ran out; treat as deep research
//
// Internal message format (shared by all provider adapters):
//   {role: "user", text}
//   {role: "assistant", text?, toolCalls?: [{id, name, args}]}
//   {role: "tool", results: [{id, name, content, isError}]}
import { isAbort } from "./providers/http.js";

export const HANDOFF_TOOL = {
  name: "start_deep_research",
  description:
    "Hand the request off to a slower, more capable research process that can take several minutes. " +
    "Use it when answering well needs many sources, comparisons, analysis or a long report. " +
    "Do not use it for simple facts or calendar actions.",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "The research question, self-contained, in the user's language." },
    },
    required: ["topic"],
  },
};

/**
 * @param {object} p
 * @param {{complete: Function}} p.provider
 * @param {string} p.model
 * @param {string} p.system
 * @param {Array} p.messages
 * @param {import("./tools.js").ToolHub} p.tools
 * @param {number} p.deadlineMs  time budget for the whole turn
 * @param {boolean} [p.allowHandoff=true]
 * @param {number} [p.maxSteps=6]
 * @param {number} [p.maxTokens=600]
 * @param {() => number} [p.now]
 */
export async function runAgent({
  provider,
  model,
  system,
  messages,
  tools,
  deadlineMs,
  allowHandoff = true,
  maxSteps = 6,
  maxTokens = 600,
  now = Date.now,
}) {
  const deadline = now() + deadlineMs;
  const history = [...messages];
  const lastUserText = [...history].reverse().find((m) => m.role === "user")?.text ?? "";
  const specs = allowHandoff ? [...tools.specs(), HANDOFF_TOOL] : tools.specs();
  const timedOut = () => ({ status: "timeout", topic: lastUserText, messages: history });

  for (let step = 0; step < maxSteps; step++) {
    const remaining = deadline - now();
    if (remaining <= 0) return timedOut();

    let res;
    try {
      res = await provider.complete({
        model,
        system,
        messages: history,
        tools: specs,
        maxTokens,
        signal: AbortSignal.timeout(remaining),
      });
    } catch (e) {
      if (isAbort(e)) return timedOut();
      throw e;
    }

    if (!res.toolCalls.length) {
      return { status: "done", speech: res.text, messages: [...history, { role: "assistant", text: res.text }] };
    }
    history.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });

    const handoff = res.toolCalls.find((c) => c.name === HANDOFF_TOOL.name);
    if (handoff) {
      const topic = String(handoff.args?.topic ?? "").trim().slice(0, 1000) || lastUserText;
      return { status: "long", topic, messages: history };
    }

    const gated = res.toolCalls.find((c) => tools.needsConfirmation(c.name));
    if (gated) {
      return {
        status: "needs_confirmation",
        pending: { name: gated.name, args: gated.args },
        prompt: res.text,
        messages: history,
      };
    }

    const results = [];
    for (const call of res.toolCalls) {
      const left = deadline - now();
      if (left <= 0) return timedOut();
      results.push(await tools.call(call, { signal: AbortSignal.timeout(left) }));
    }
    history.push({ role: "tool", results });

    const quick = tools.quickReply(res.toolCalls, results);
    if (quick) return { status: "done", speech: quick, messages: history };
  }
  return timedOut();
}
