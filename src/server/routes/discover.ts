// Server-side only — POST /api/discover route handler.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DiscoverContext, Fulfillment, ProviderCooldownStore } from '../../lib/recipes/base';
import { isDiscoverableRecipe } from '../../lib/recipes/base';
import { requirePositiveNumber, requireString } from '../../lib/validate';
import { bindAIConfigResolver, getAIConfig } from '../ai';
import { readBody, sendJSON } from '../helpers';
import { getAllRecipes } from '../recipes/registry';

const SENSITIVE_TOKEN_PATTERNS = [/sk-[a-zA-Z0-9]+/g, /api[_-]?key[=:]\S+/gi, /bearer \S+/gi];

export function sanitiseWarningMessage(reason: unknown): string {
  const rawMessage = reason instanceof Error ? reason.message : 'Recipe failed';
  return SENSITIVE_TOKEN_PATTERNS.reduce(
    (message, pattern) => message.replace(pattern, '[redacted]'),
    rawMessage
  );
}

type DiscoverResult = {
  urls: string[];
  name: string;
  warnings: string[];
};

export async function discoverCategoriesAsync(
  discoveryPrompt: string,
  discoveryMaxPrice: number,
  discoveryFulfillment: Fulfillment,
  discoveryRegion: string | undefined,
  cooldownStore: ProviderCooldownStore,
  discoveryIncludeSoldItems = false
): Promise<DiscoverResult> {
  getAIConfig(cooldownStore); // fail fast before running any recipe if no provider is configured at all
  const context: DiscoverContext = {
    maxPrice: discoveryMaxPrice,
    fulfillment: discoveryFulfillment,
    regionValue: discoveryRegion,
    includeSoldItems: discoveryIncludeSoldItems,
    getAiConfig: bindAIConfigResolver(cooldownStore),
  };
  const allRecipes = getAllRecipes();
  const recipes = allRecipes.filter(isDiscoverableRecipe);
  const settled = await Promise.allSettled(
    recipes.map((r) => r.buildDiscoverUrlsAsync(discoveryPrompt, context))
  );
  const urls = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.urls : []));
  const warnings = [
    ...settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.warnings : [])),
    ...settled
      .map((r, i) => ({ result: r, recipe: recipes[i] }))
      .filter(
        (entry): entry is { result: PromiseRejectedResult; recipe: (typeof recipes)[number] } =>
          entry.result.status === 'rejected'
      )
      .map(({ result, recipe }) => `${recipe.name}: ${sanitiseWarningMessage(result.reason)}`),
  ];
  if (urls.length === 0)
    throw new Error(`No URLs returned from any recipe. Errors: ${warnings.join('; ')}`);
  return { urls, name: discoveryPrompt.trim(), warnings };
}

export async function handleDiscover(
  request: IncomingMessage,
  response: ServerResponse,
  cooldownStore: ProviderCooldownStore
): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let discoveryPrompt: string;
  let discoveryMaxPrice: number;
  try {
    discoveryPrompt = requireString(rawBody.prompt, 'prompt');
    discoveryMaxPrice = requirePositiveNumber(rawBody.maxPrice, 'maxPrice');
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message });
    return;
  }
  const VALID_FULFILLMENTS = new Set<Fulfillment>(['any', 'pickup', 'shipping']);
  const rawFulfillment = typeof rawBody.fulfillment === 'string' ? rawBody.fulfillment : 'any';
  const discoveryFulfillment: Fulfillment = VALID_FULFILLMENTS.has(rawFulfillment as Fulfillment)
    ? (rawFulfillment as Fulfillment)
    : 'any';
  const discoveryRegion =
    typeof rawBody.regionValue === 'string' && rawBody.regionValue.trim()
      ? rawBody.regionValue
      : undefined;
  const discoveryIncludeSoldItems = rawBody.includeSoldItems === true;

  try {
    const result = await discoverCategoriesAsync(
      discoveryPrompt,
      discoveryMaxPrice,
      discoveryFulfillment,
      discoveryRegion,
      cooldownStore,
      discoveryIncludeSoldItems
    );
    sendJSON(response, 200, result);
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
  }
}
