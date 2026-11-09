import { anthropicProvider } from "./anthropic.js";
import { openAICompatibleProvider } from "./openai-compatible.js";
import { providerConfig } from "../registry.js";

/**
 * Builds the provider adapter for a user's AI company.
 *
 * Every adapter implements:
 *   complete({model, system, messages, tools, maxTokens, signal}) → {text, toolCalls: [{id, name, args}]}
 *   listModels({signal}) → [{id, created?}]
 */
export function createProvider(registry, providerId, apiKey, { fetchImpl } = {}) {
  if (!apiKey) throw new Error("Missing API key for the AI provider.");
  const cfg = providerConfig(registry, providerId);
  if (cfg.api === "anthropic") return anthropicProvider({ apiKey, baseUrl: cfg.baseUrl, fetchImpl });
  if (cfg.api === "openai-compatible") {
    return openAICompatibleProvider({ apiKey, baseUrl: cfg.baseUrl, maxTokensParam: cfg.maxTokensParam, fetchImpl });
  }
  throw new Error(`Unknown provider API type: ${cfg.api}`);
}

export { ProviderError, isAbort } from "./http.js";
