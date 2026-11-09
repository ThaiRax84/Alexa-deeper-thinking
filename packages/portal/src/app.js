// Portal HTTP routes. Pure request → response, with all I/O injected, so it can be
// tested without AWS. Served by a Lambda Function URL (see index.js).

const CHANNELS = ["voz", "whatsapp", "correo"];
const MAX_BODY = 10_000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PHONE = /^\+?\d{10,15}$/;
const APP_PASSWORD = /^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (statusCode, data) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(data),
});

const isTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

function parseBody(req) {
  if (!req.body) return {};
  if (req.body.length > MAX_BODY) throw new HttpError(413, "Solicitud demasiado grande.");
  try {
    const data = JSON.parse(req.body);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

const str = (v, max) => (typeof v === "string" && v.trim().length <= max ? v.trim() : undefined);

/**
 * @param {object} deps
 * @param {(token: string) => Promise<string|null>} deps.verifyToken   Cognito access token → sub
 * @param {object} deps.store
 * @param {{encrypt(plain, userId): string}} deps.secrets
 * @param {object} deps.registry
 * @param {(provider: string, apiKey: string) => Promise<{fast, deep}>} deps.validateAi
 * @param {(creds) => Promise<{calendars: number}>} deps.validateCalendar
 * @param {{cognitoDomain: string, clientId: string, providers: {id, label}[]}} deps.publicConfig
 * @param {Record<string, {type: string, body: string}>} deps.assets   static pages by path
 * @param {string} deps.csp
 */
export function createApp(deps) {
  async function userOf(req) {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const sub = token ? await deps.verifyToken(token) : null;
    if (!sub) throw new HttpError(401, "Inicia sesión de nuevo.");
    return sub;
  }

  const api = {
    "GET /api/config": async () => json(200, deps.publicConfig),

    "GET /api/me": async (req) => {
      const userId = await userOf(req);
      const u = (await deps.store.getUser(userId)) ?? {};
      return json(200, {
        ai: u.ai?.provider
          ? { provider: u.ai.provider, label: deps.registry.providers[u.ai.provider]?.label, models: u.ai.models }
          : null,
        calendar: u.calendar ? { type: u.calendar.type, username: u.calendar.username } : null,
        timezone: u.timezone ?? null,
        preferredChannel: u.preferredChannel ?? null,
        contact: u.contact ?? {},
      });
    },

    "PUT /api/ai": async (req) => {
      const userId = await userOf(req);
      const { provider, apiKey } = parseBody(req);
      if (!deps.registry.providers[provider]) throw new HttpError(400, "Elige una empresa de IA de la lista.");
      const key = str(apiKey, 500);
      if (!key || key.length < 10) throw new HttpError(400, "Pega una llave de API válida.");
      const models = await deps.validateAi(provider, key);
      await deps.store.saveAi(userId, { provider, apiKeyEnc: deps.secrets.encrypt(key, userId), models });
      return json(200, { provider, label: deps.registry.providers[provider].label, models });
    },

    "PUT /api/calendar": async (req) => {
      const userId = await userOf(req);
      const body = parseBody(req);
      const username = str(body.username, 200);
      const appPassword = str(body.appPassword, 40);
      if (!username || !EMAIL.test(username)) throw new HttpError(400, "Escribe el correo de tu Apple ID.");
      if (!appPassword || !APP_PASSWORD.test(appPassword)) {
        throw new HttpError(400, "La contraseña de app tiene el formato xxxx-xxxx-xxxx-xxxx.");
      }
      const user = (await deps.store.getUser(userId)) ?? {};
      const { calendars } = await deps.validateCalendar({
        username,
        appPassword,
        timezone: user.timezone || "America/Mexico_City",
      });
      await deps.store.saveCalendar(userId, {
        type: "icloud",
        username,
        appPasswordEnc: deps.secrets.encrypt(appPassword, userId),
      });
      return json(200, { username, calendars });
    },

    "DELETE /api/calendar": async (req) => {
      await deps.store.removeCalendar(await userOf(req));
      return json(200, { ok: true });
    },

    "PUT /api/preferences": async (req) => {
      const userId = await userOf(req);
      const body = parseBody(req);
      const prefs = {};
      if (body.timezone !== undefined) {
        if (!isTimezone(body.timezone)) throw new HttpError(400, "Zona horaria no válida.");
        prefs.timezone = body.timezone;
      }
      if (body.preferredChannel !== undefined) {
        if (!CHANNELS.includes(body.preferredChannel)) throw new HttpError(400, "Canal no válido.");
        prefs.preferredChannel = body.preferredChannel;
      }
      if (body.email !== undefined || body.phone !== undefined) {
        const email = str(body.email ?? "", 254);
        const phone = str(body.phone ?? "", 20)?.replace(/[\s()-]/g, "");
        if (email && !EMAIL.test(email)) throw new HttpError(400, "Correo no válido.");
        if (phone && !PHONE.test(phone)) throw new HttpError(400, "Número de WhatsApp no válido (10 a 15 dígitos, con lada).");
        prefs.contact = { ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
      }
      await deps.store.savePreferences(userId, prefs);
      return json(200, { ok: true });
    },

    "DELETE /api/me": async (req) => {
      await deps.store.deleteUser(await userOf(req));
      return json(200, { ok: true });
    },
  };

  return async function handle(req) {
    try {
      const route = api[`${req.method} ${req.path}`];
      if (route) return await route(req);
      if (req.path.startsWith("/api/")) throw new HttpError(404, "No encontrado.");
      const asset = req.method === "GET" && deps.assets[req.path];
      if (!asset) return { statusCode: 404, headers: { "content-type": "text/plain" }, body: "No encontrado" };
      return {
        statusCode: 200,
        headers: {
          "content-type": asset.type,
          "content-security-policy": deps.csp,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cache-control": "no-cache",
        },
        body: asset.body,
      };
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      if (e?.publicMessage) return json(400, { error: e.publicMessage });
      console.error(JSON.stringify({ level: "error", name: e?.name, message: e?.message }));
      return json(500, { error: "Algo salió mal. Intenta de nuevo." });
    }
  };
}
