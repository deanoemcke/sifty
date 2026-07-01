import type { AiConfig } from "../../src/server/ai";
import { AI_PROVIDERS } from "../../src/server/ai";

export const PROVIDER_NAMES = Object.keys(AI_PROVIDERS);

export function buildProviderConfig(name: string): AiConfig {
  const provider = AI_PROVIDERS[name];
  if (!provider) throw new Error(`Unknown provider "${name}" — use ${PROVIDER_NAMES.join(", ")}`);
  const apiKey = process.env[provider.keyVar];
  if (!apiKey) throw new Error(`${provider.keyVar} is not set`);
  return { url: provider.url, model: provider.model, apiKey };
}

export function buildAllProviderConfigs(): Record<string, AiConfig> {
  const configs: Record<string, AiConfig> = {};
  for (const name of PROVIDER_NAMES) {
    const provider = AI_PROVIDERS[name];
    const apiKey = process.env[provider.keyVar];
    if (apiKey) configs[name] = { url: provider.url, model: provider.model, apiKey };
  }
  return configs;
}
