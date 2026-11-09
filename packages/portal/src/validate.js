// Checks a user's AI key and iCloud credentials before saving them, and turns
// failures into messages the user can act on (error.publicMessage).
import { connectCalendar, createProvider, resolveModels, ModelResolutionError } from "@deeper-thinking/core";

const publicError = (message) => Object.assign(new Error(message), { publicMessage: message });

export function makeValidators({ registry, connect = connectCalendar, fetchImpl }) {
  return {
    async validateAi(providerId, apiKey) {
      const label = registry.providers[providerId].label;
      const provider = createProvider(registry, providerId, apiKey, { fetchImpl });
      let models;
      try {
        models = await provider.listModels({ signal: AbortSignal.timeout(8000) });
      } catch (e) {
        if (e?.kind === "auth") throw publicError(`${label} rechazó la llave. Revisa que esté completa y activa.`);
        throw publicError(`No pude comunicarme con ${label}. Intenta de nuevo en un momento.`);
      }
      try {
        return resolveModels(registry, providerId, models);
      } catch (e) {
        if (e instanceof ModelResolutionError) {
          throw publicError(`Tu llave de ${label} no tiene acceso a los modelos que necesitamos.`);
        }
        throw e;
      }
    },

    async validateCalendar(creds) {
      const client = await connect(creds);
      try {
        const res = await client.callTool({ name: "list_calendars", arguments: {} }, undefined, {
          signal: AbortSignal.timeout(15_000),
        });
        if (res.isError) throw publicError("iCloud rechazó el acceso. Revisa tu Apple ID y la contraseña de app.");
        const calendars = JSON.parse(res.content?.[0]?.text ?? "[]");
        return { calendars: Array.isArray(calendars) ? calendars.length : 0 };
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
