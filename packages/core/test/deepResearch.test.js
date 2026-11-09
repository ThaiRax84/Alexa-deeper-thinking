import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResearch, runDeepResearch, ToolHub } from "../src/index.js";

test("parses the summary and report tags", () => {
  const r = parseResearch("<resumen>Corto y claro.</resumen>\n<reporte># Reporte\nDetalle</reporte>");
  assert.deepEqual(r, { summary: "Corto y claro.", report: "# Reporte\nDetalle" });
});

test("tolerates output without tags", () => {
  const r = parseResearch("Primer párrafo.\n\nSegundo párrafo.");
  assert.equal(r.summary, "Primer párrafo.");
  assert.equal(r.report, "Primer párrafo.\n\nSegundo párrafo.");
});

test("caps the spoken summary at a sentence boundary", () => {
  const long = `${"Esta es una oración larga. ".repeat(60)}`;
  const { summary } = parseResearch(`<resumen>${long}</resumen><reporte>r</reporte>`);
  assert.ok(summary.length <= 900);
  assert.ok(summary.endsWith("."));
});

test("when time runs out it asks the model to write up what it has", async () => {
  const seen = [];
  const provider = {
    async complete(req) {
      seen.push(req);
      if (req.tools.length === 0) return { text: "<resumen>Lo que hay.</resumen><reporte>R</reporte>", toolCalls: [] };
      return new Promise((_, reject) => {
        const keep = setTimeout(() => {}, 5000);
        req.signal.addEventListener("abort", () => {
          clearTimeout(keep);
          reject(req.signal.reason);
        });
      });
    },
  };
  const r = await runDeepResearch({
    provider,
    model: "deep",
    topic: "tema",
    tools: new ToolHub(),
    timezone: "America/Mexico_City",
    deadlineMs: 20,
  });
  assert.deepEqual(r, { summary: "Lo que hay.", report: "R" });
  assert.equal(seen.at(-1).messages.at(-1).role, "user");
  assert.ok(!seen[0].tools.some((t) => t.name === "start_deep_research"));
});
