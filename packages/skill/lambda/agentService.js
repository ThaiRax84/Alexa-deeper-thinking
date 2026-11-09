// Builds the per-user agent (provider, models, tools) and runs voice turns.
import {
  runAgent,
  ToolHub,
  createProvider,
  resolveModels,
  webSearchTool,
  calendarQuickReplies,
  voiceSystemPrompt,
} from "@deeper-thinking/core";

const DEFAULT_TIMEZONE = "America/Mexico_City";

/**
 * @param {object} p
 * @param {object} p.registry       model registry (loadRegistry())
 * @param {{decrypt(cipher: string, userId: string): Promise<string>}} p.secrets
 * @param {{saveModels(userId, models): Promise<void>}} p.store
 * @param {import("@deeper-thinking/core").CalendarPool} p.calendarPool
 * @param {string} [p.searchApiKey] operator key for web search
 * @param {number} [p.deadlineMs]   budget for a voice turn (Alexa allows ~8 s in total)
 */
export function createAgentService({ registry, secrets, store, calendarPool, searchApiKey, deadlineMs = 6000, fetchImpl, now = () => new Date() }) {
  async function setup(user) {
    const apiKey = await secrets.decrypt(user.ai.apiKeyEnc, user.userId);
    const provider = createProvider(registry, user.ai.provider, apiKey, { fetchImpl });

    let models = user.ai.models;
    if (!models?.fast || !models?.deep) {
      models = resolveModels(registry, user.ai.provider, await provider.listModels());
      await store.saveModels(user.userId, models);
    }

    const timezone = user.timezone || DEFAULT_TIMEZONE;
    const tools = new ToolHub();
    if (searchApiKey) tools.addLocal(webSearchTool({ apiKey: searchApiKey, fetchImpl }));

    let hasCalendar = false;
    if (user.calendar?.type === "icloud" && user.calendar.appPasswordEnc) {
      const appPassword = await secrets.decrypt(user.calendar.appPasswordEnc, user.userId);
      const client = await calendarPool.get(user.userId, { username: user.calendar.username, appPassword, timezone });
      await tools.addMcp(client, { quickReplies: calendarQuickReplies(timezone) });
      hasCalendar = true;
    }
    return { provider, models, tools, timezone, hasCalendar };
  }

  return {
    /** One voice turn with the light model, inside the Alexa time budget. */
    async run({ user, text }) {
      const started = Date.now();
      const s = await setup(user);
      return runAgent({
        provider: s.provider,
        model: s.models.fast,
        system: voiceSystemPrompt({ now: now(), timezone: s.timezone, hasCalendar: s.hasCalendar }),
        messages: [{ role: "user", text }],
        tools: s.tools,
        deadlineMs: deadlineMs - (Date.now() - started),
      });
    },

    /** Runs a destructive action after the user said "yes". Returns the text to speak. */
    async executePending({ user, pending }) {
      const s = await setup(user);
      const result = await s.tools.executeConfirmed(pending);
      if (result.isError) return "No pude completar la acción. Revisa que el evento todavía exista e intenta de nuevo.";
      return s.tools.quickReply([pending], [result]) ?? "Listo, hecho.";
    },
  };
}
