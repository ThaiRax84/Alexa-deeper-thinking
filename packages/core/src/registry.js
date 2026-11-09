// Model registry: which AI companies are supported and how to pick a light model
// (routing, voice answers) and a capable model (deep research) for each one.
//
// The registry stores model *families* instead of exact IDs. When a user connects
// their API key, the provider's own model list is fetched and the newest model of
// each family is chosen. An operator can override any entry (e.g. from S3) without
// redeploying, and can pin an exact ID per role.
import { readFileSync } from "node:fs";

const DEFAULTS = JSON.parse(readFileSync(new URL("./registry.json", import.meta.url), "utf8"));

export class ModelResolutionError extends Error {
  constructor(provider, role) {
    super(`No ${role} model available for provider "${provider}".`);
    this.name = "ModelResolutionError";
    this.provider = provider;
    this.role = role;
  }
}

/** Default registry merged with an optional operator override (shallow per provider). */
export function loadRegistry(override = {}) {
  const providers = { ...DEFAULTS.providers };
  for (const [key, value] of Object.entries(override.providers ?? {})) {
    providers[key] = value === null ? undefined : { ...providers[key], ...value };
  }
  for (const key of Object.keys(providers)) if (!providers[key]) delete providers[key];
  return { ...DEFAULTS, ...override, providers };
}

/** Companies a user can pick during onboarding. */
export const listProviders = (registry) =>
  Object.entries(registry.providers).map(([id, p]) => ({ id, label: p.label }));

export function providerConfig(registry, providerId) {
  const cfg = registry.providers[providerId];
  if (!cfg) throw new Error(`Unsupported AI provider: ${providerId}`);
  return cfg;
}

/** "gemini-3.8-flash" → [3, 8]; used when a provider does not report creation dates. */
const versionOf = (id) => (id.match(/\d+/g) ?? []).map(Number);

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? -1) - (a[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

const newestFirst = (a, b) => {
  const byPreview = Number(/preview|exp/i.test(a.id)) - Number(/preview|exp/i.test(b.id));
  if (a.created && b.created && a.created !== b.created) return b.created - a.created || byPreview;
  return compareVersions(versionOf(a.id), versionOf(b.id)) || byPreview;
};

/**
 * Picks the light ("fast") and capable ("deep") model for a provider.
 * @param {object} registry
 * @param {string} providerId
 * @param {{id: string, created?: number}[]} available  models returned by the provider for this key
 * @returns {{fast: string, deep: string}}
 */
export function resolveModels(registry, providerId, available) {
  const cfg = providerConfig(registry, providerId);
  const ids = new Set(available.map((m) => m.id));
  const globalExclude = registry.exclude ?? [];
  const pick = (role) => {
    const pinned = cfg.pinned?.[role];
    if (pinned && ids.has(pinned)) return pinned;
    const rule = cfg[role] ?? {};
    const exclude = [...globalExclude, ...(rule.exclude ?? [])];
    const candidates = available.filter((m) => {
      const id = m.id.toLowerCase();
      return (rule.include ?? []).some((p) => id.includes(p)) && !exclude.some((p) => id.includes(p));
    });
    if (!candidates.length) throw new ModelResolutionError(providerId, role);
    return candidates.sort(newestFirst)[0].id;
  };
  return { fast: pick("fast"), deep: pick("deep") };
}
