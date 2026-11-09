// Delivery channels for finished research: email (Amazon SES) and WhatsApp
// (Meta WhatsApp Cloud API, with an approved template so it can be sent at any time).
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { markdownToHtml } from "./markdown.js";

export class DeliveryError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.permanent = permanent;
  }
}

export function renderEmail({ topic, summary, report }) {
  const subject = `Tu investigación: ${String(topic).replace(/\s+/g, " ").slice(0, 120)}`;
  const text = `${summary}\n\n${report}\n\n—\nDeeper Thinking for Alexa`;
  const html = `<!doctype html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:680px;margin:auto;line-height:1.5;color:#222">
<p style="font-size:1.05em"><strong>${markdownToHtml(summary).replace(/^<p>|<\/p>$/g, "")}</strong></p>
<hr>
${markdownToHtml(report)}
<hr><p style="color:#777;font-size:.85em">Deeper Thinking for Alexa</p>
</body></html>`;
  return { subject, text, html };
}

export function sesEmail({ from, client = new SESv2Client({}) }) {
  return {
    async send(to, { subject, text, html }) {
      try {
        await client.send(
          new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: {
              Simple: {
                Subject: { Data: subject, Charset: "UTF-8" },
                Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
              },
            },
          })
        );
      } catch (e) {
        const permanent = ["MessageRejected", "MailFromDomainNotVerifiedException", "AccountSuspendedException", "BadRequestException"].includes(e?.name);
        throw new DeliveryError(`Email not sent: ${e?.name ?? "error"}`, { permanent });
      }
    },
  };
}

/** Template parameters cannot contain new lines, tabs or more than four spaces in a row. */
export const templateText = (s, max) => {
  const clean = String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};

/**
 * @param {object} p
 * @param {string} p.token          system-user access token (stored in SSM)
 * @param {string} p.phoneNumberId  sender phone number ID from Meta
 * @param {string} [p.template]     approved template: header DOCUMENT, body {{1}} topic, {{2}} summary
 * @param {string} [p.language]
 * @param {string} [p.apiVersion]
 */
export function whatsAppCloud({ token, phoneNumberId, template = "investigacion_lista", language = "es_MX", apiVersion = "v26.0", fetchImpl = fetch }) {
  const base = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`;
  const auth = { authorization: `Bearer ${token}` };

  async function call(path, init) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...auth, ...init.headers }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new DeliveryError("WhatsApp is not reachable.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw new DeliveryError(`WhatsApp error ${res.status}: ${body?.error?.message ?? ""}`.slice(0, 300), { permanent });
    }
    return body;
  }

  return {
    async send(to, { topic, summary, report }) {
      const phone = String(to).replace(/[^\d]/g, "");
      if (phone.length < 10) throw new DeliveryError("Invalid phone number.", { permanent: true });

      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", "text/plain");
      form.append("file", new Blob([`${topic}\n\n${summary}\n\n${report}`], { type: "text/plain" }), "investigacion.txt");
      const media = await call("/media", { method: "POST", body: form });

      await call("/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: template,
            language: { code: language },
            components: [
              { type: "header", parameters: [{ type: "document", document: { id: media.id, filename: "investigacion.txt" } }] },
              {
                type: "body",
                parameters: [
                  { type: "text", text: templateText(topic, 60) },
                  { type: "text", text: templateText(summary, 700) },
                ],
              },
            ],
          },
        }),
      });
    },
  };
}
