// Deep research with the capable model. Runs in the worker, outside Alexa's time limit.
import { runAgent } from "./agent.js";
import { researchSystemPrompt } from "./prompt.js";

const FINALIZE =
  "Se acabó el tiempo de búsqueda. Escribe ya el resultado final con la información que tienes, en el formato pedido.";
const MAX_SUMMARY_CHARS = 900;

/** Splits "<resumen>…</resumen><reporte>…</reporte>" into its parts, tolerating sloppy output. */
export function parseResearch(text) {
  const raw = String(text ?? "").trim();
  const grab = (tag) => raw.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, "i"))?.[1]?.trim();
  const report = grab("reporte") || raw.replace(/<resumen>[\s\S]*?<\/resumen>/i, "").trim() || raw;
  let summary = grab("resumen") || report.split(/\n\s*\n/)[0];
  summary = summary.replace(/\s+/g, " ").trim();
  if (summary.length > MAX_SUMMARY_CHARS) {
    const cut = summary.slice(0, MAX_SUMMARY_CHARS);
    summary = cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, MAX_SUMMARY_CHARS / 2));
  }
  return { summary, report };
}

/** Drops a trailing assistant turn whose tool calls never got results (cut off by the deadline). */
function closeHistory(messages) {
  const out = [...messages];
  const last = out.at(-1);
  if (last?.role === "assistant" && last.toolCalls?.length) out.pop();
  return out;
}

/**
 * @param {object} p
 * @param {{complete: Function}} p.provider
 * @param {string} p.model      the user's deep model
 * @param {string} p.topic
 * @param {import("./tools.js").ToolHub} p.tools  web_search + read_page
 * @param {string} p.timezone
 * @param {number} [p.deadlineMs=12 * 60_000]
 * @returns {Promise<{summary: string, report: string}>}
 */
export async function runDeepResearch({ provider, model, topic, tools, timezone, deadlineMs = 12 * 60_000, now = new Date() }) {
  const system = researchSystemPrompt({ now, timezone });
  const r = await runAgent({
    provider,
    model,
    system,
    messages: [{ role: "user", text: topic }],
    tools,
    deadlineMs,
    allowHandoff: false,
    maxSteps: 16,
    maxTokens: 4096,
  });
  if (r.status === "done" && r.speech) return parseResearch(r.speech);

  const final = await provider.complete({
    model,
    system,
    messages: [...closeHistory(r.messages ?? []), { role: "user", text: FINALIZE }],
    tools: [],
    maxTokens: 4096,
    signal: AbortSignal.timeout(120_000),
  });
  return parseResearch(final.text);
}
