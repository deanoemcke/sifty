// Server-side only — POST /api/ai-filter route handler.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderCooldownStore } from '../../lib/recipes/base';
import { requireArray, requireListingUrl, requireString } from '../../lib/validate';
import { getAIConfig } from '../ai';
import { readBody, sendJSON, sse, startSSE } from '../helpers';
import { type AiFilterListing, runAiFilterBatchesAsync } from '../services/aiFilter';

export type { AiFilterListing, FilterResultEntry } from '../services/aiFilter';
export {
  clampRelevance,
  isValidFilterResultEntry,
  runAiFilterBatchesAsync,
} from '../services/aiFilter';

export async function handleAiFilter(
  request: IncomingMessage,
  response: ServerResponse,
  cooldownStore: ProviderCooldownStore
): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let listings: AiFilterListing[];
  let prompt: string;
  try {
    const rawListings = requireArray(rawBody.listings, 'listings');
    // Each item is trusted as the expected shape — url presence is the only safety-critical field
    listings = rawListings.map((item, listingIndex) =>
      requireListingUrl(item, listingIndex)
    ) as typeof listings;
    prompt = requireString(rawBody.prompt, 'prompt');
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message });
    return;
  }

  try {
    getAIConfig(cooldownStore); // fail fast before opening the SSE stream if no provider is configured at all
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
    return;
  }

  startSSE(response);
  await runAiFilterBatchesAsync(
    listings,
    prompt,
    cooldownStore,
    (results) => sse(response, { type: 'result', results }),
    (message) => sse(response, { type: 'error', message })
  );
  response.end();
}
