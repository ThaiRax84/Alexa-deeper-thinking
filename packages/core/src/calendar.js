// Connects to the calendar MCP server (packages/calendar-mcp) as a stdio subprocess,
// one per user, with that user's own iCloud credentials in its environment.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_PATH = fileURLToPath(import.meta.resolve("@deeper-thinking/calendar-mcp"));

/** @returns {Promise<Client>} */
export async function connectCalendar({ username, appPassword, timezone }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    // Only what the server needs: the SDK does not forward the parent's full environment.
    env: {
      ICLOUD_USERNAME: username,
      ICLOUD_APP_PASSWORD: appPassword,
      TZ_NAME: timezone,
      PATH: process.env.PATH ?? "",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "deeper-thinking", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/**
 * Keeps calendar connections alive between requests on a warm Lambda, so the
 * subprocess start and iCloud sign-in are paid once per user, not per request.
 */
export class CalendarPool {
  constructor({ connect = connectCalendar, max = 20, idleMs = 5 * 60_000, now = Date.now } = {}) {
    Object.assign(this, { connect, max, idleMs, now });
    /** @type {Map<string, {client: Promise<Client>, fingerprint: string, lastUsed: number}>} */
    this.entries = new Map();
  }

  async get(key, creds) {
    this.#evict();
    const fingerprint = createHash("sha256")
      .update(`${creds.username}\0${creds.timezone}\0${creds.appPassword}`)
      .digest("hex");
    let entry = this.entries.get(key);
    if (entry && entry.fingerprint !== fingerprint) {
      await this.#close(key);
      entry = undefined;
    }
    if (!entry) {
      const client = this.connect(creds);
      client.catch(() => this.entries.delete(key));
      entry = { client, fingerprint, lastUsed: this.now() };
      this.entries.set(key, entry);
    }
    entry.lastUsed = this.now();
    return entry.client;
  }

  async #close(key) {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    await entry?.client.then((c) => c.close()).catch(() => {});
  }

  #evict() {
    const t = this.now();
    for (const [key, e] of this.entries) if (t - e.lastUsed > this.idleMs) this.#close(key);
    while (this.entries.size >= this.max) this.#close(this.entries.keys().next().value);
  }
}

/** Spoken confirmations built without a second model call (saves ~1 s per request). */
export function calendarQuickReplies(timezone, locale = "es-MX") {
  return {
    add_event: (args) => {
      const when = DateTime.fromISO(String(args.start ?? ""), { setZone: true });
      if (!args.title || !when.isValid) return undefined;
      const local = when.setZone(timezone).setLocale(locale);
      const repeat = args.recurrence ? ", con repetición" : "";
      return `Listo, agregué "${args.title}" el ${local.toFormat("cccc d 'de' LLLL 'a las' H:mm")}${repeat}.`;
    },
  };
}
