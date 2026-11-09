import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "@deeper-thinking/core";
import { processJob } from "../src/worker.js";
import { DeliveryError, renderEmail, templateText, whatsAppCloud } from "../src/delivery.js";
import { markdownToHtml } from "../src/markdown.js";

const MSG = { userId: "u1", jobId: "j1", createdAt: "2026-11-09T19:00:00.000Z" };
const SK = "2026-11-09T19:00:00.000Z#j1";
const USER = { userId: "u1", ai: { provider: "anthropic", apiKeyEnc: "enc", models: { fast: "f", deep: "d" } } };

function deps({ job = {}, research, email, whatsapp, saved = null } = {}) {
  const log = { completed: [], failed: [], emails: [], whatsapps: [], put: [], researched: 0 };
  const d = {
    log,
    maxAttempts: 3,
    store: {
      getJob: async (u, sk) => (sk === SK ? { userId: u, sk, jobId: "j1", topic: "paneles solares", channel: "voz", status: "queued", attempts: 0, ...job } : undefined),
      claimJob: async () => true,
      getUser: async () => USER,
      completeJob: async (u, sk, r) => log.completed.push(r),
      failJob: async (u, sk, e) => log.failed.push(e),
    },
    reports: { get: async () => saved, put: async (k, r) => log.put.push([k, r]) },
    research:
      research ??
      (async () => {
        log.researched++;
        return { summary: "Convienen con mucho sol.", report: "# Reporte\n- dato" };
      }),
    email: email ?? { send: async (to, m) => log.emails.push([to, m]) },
    whatsapp: whatsapp ?? { send: async (to, m) => log.whatsapps.push([to, m]) },
  };
  return d;
}

test("voice jobs are researched, saved and completed", async () => {
  const d = deps();
  assert.equal(await processJob(d, MSG), "done");
  assert.equal(d.log.put[0][0], "reports/u1/j1.json");
  assert.deepEqual(d.log.completed, [{ summary: "Convienen con mucho sol.", reportKey: "reports/u1/j1.json" }]);
});

test("email jobs send the rendered report to the destination", async () => {
  const d = deps({ job: { channel: "correo", destination: "a@b.mx" } });
  await processJob(d, MSG);
  assert.equal(d.log.emails[0][0], "a@b.mx");
  assert.match(d.log.emails[0][1].subject, /paneles solares/);
  assert.match(d.log.emails[0][1].html, /<h2>Reporte<\/h2>/);
});

test("finished or unknown jobs are skipped (duplicate queue delivery)", async () => {
  assert.equal(await processJob(deps({ job: { status: "done" } }), MSG), "skipped");
  assert.equal(await processJob(deps(), { ...MSG, jobId: "other" }), "skipped");
});

test("a saved result is reused on retry instead of researching again", async () => {
  const d = deps({ saved: { summary: "guardado", report: "r" } });
  await processJob(d, MSG);
  assert.equal(d.log.researched, 0);
  assert.equal(d.log.completed[0].summary, "guardado");
});

test("a rejected API key fails the job without retrying", async () => {
  const d = deps({
    research: async () => {
      throw new ProviderError("auth", "HTTP 401", 401);
    },
  });
  assert.equal(await processJob(d, MSG), "failed");
  assert.equal(d.log.failed.length, 1);
});

test("transient errors are retried until the last attempt", async () => {
  const boom = async () => {
    throw new ProviderError("unavailable", "HTTP 503", 503);
  };
  await assert.rejects(processJob(deps({ research: boom }), MSG), /503/);
  const last = deps({ research: boom, job: { attempts: 2 } });
  assert.equal(await processJob(last, MSG), "failed");
});

test("a permanent delivery error keeps the result available by voice", async () => {
  const whatsapp = {
    send: async () => {
      throw new DeliveryError("WhatsApp error 400", { permanent: true });
    },
  };
  const d = deps({ job: { channel: "whatsapp", destination: "+525512345678" }, whatsapp });
  assert.equal(await processJob(d, MSG), "done");
  assert.match(d.log.completed[0].deliveryError, /WhatsApp error 400/);
});

test("WhatsApp uploads the report and sends the approved template", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => (url.endsWith("/media") ? { id: "media-1" } : { messages: [{ id: "m" }] }) };
  };
  const wa = whatsAppCloud({ token: "t", phoneNumberId: "123", fetchImpl });
  await wa.send("+52 55 1234 5678", { topic: "Tema\ncon salto", summary: "Resumen", report: "r" });
  assert.equal(calls[0].url, "https://graph.facebook.com/v26.0/123/media");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.to, "525512345678");
  assert.equal(body.template.name, "investigacion_lista");
  assert.equal(body.template.components[0].parameters[0].document.id, "media-1");
  assert.equal(body.template.components[1].parameters[0].text, "Tema con salto");
  assert.equal(calls[1].init.headers.authorization, "Bearer t");
});

test("WhatsApp 4xx errors are permanent, 5xx and 429 are not", async () => {
  const failing = (status) =>
    whatsAppCloud({ token: "t", phoneNumberId: "1", fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }) });
  await assert.rejects(failing(400).send("5255", {}), (e) => e.permanent === true);
  await assert.rejects(failing(429).send("525512345678", {}), (e) => e.permanent === false);
  await assert.rejects(failing(503).send("525512345678", {}), (e) => e.permanent === false);
});

test("template parameters are cleaned and capped", () => {
  assert.equal(templateText("a\n\tb     c", 50), "a b c");
  assert.equal(templateText("x".repeat(20), 10), `${"x".repeat(9)}…`);
});

test("email HTML escapes markup coming from web pages", () => {
  const html = markdownToHtml('# Título\nTexto <script>alert(1)</script> y [fuente](https://ej.mx) y [mala](javascript:alert(1))\n- uno\n- **dos**');
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes('<a href="https://ej.mx">fuente</a>'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes("<ul><li>uno</li><li><strong>dos</strong></li></ul>"));
  assert.match(renderEmail({ topic: "t", summary: "s", report: "r" }).text, /^s\n\nr/);
});
