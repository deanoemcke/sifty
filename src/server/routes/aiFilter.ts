// Server-side only — POST /api/ai-filter route handler.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConcurrencyQueue } from '../../lib/queue';
import type { ProviderCooldownStore } from '../../lib/recipes/base';
import { requireArray, requireListingUrl, requireString } from '../../lib/validate';
import { aiJSON, applyAiJsonResult, getAIConfig } from '../ai';
import { readBody, sendJSON, sse, startSSE } from '../helpers';

const AI_FILTER_SYSTEM_MESSAGE =
  'You are filtering marketplace listings. For each listing decide if it is relevant to what the user is searching for. Keep listings that match or could plausibly match what the user wants, including ones that describe the same type of item with different words. Reject listings that are clearly for a different type of item. When genuinely uncertain, pass the listing. Also score how closely each listing matches the search criteria with a "relevance" integer from 0 to 9, where 0 is completely unrelated and 9 is a perfect match — assign this regardless of whether the listing passes or fails. Respond ONLY with a JSON object containing a single "results" array, one object per listing in order: {"results":[{"index":1,"pass":true,"reason":null,"relevance":7},…]}. "reason" is a short phrase when pass is false, otherwise null.';
const BATCH_SIZE = 50;

// The LLM's relevance score is untrusted external data — clamp it into the
// documented 0-9 contract rather than propagating an out-of-range or
// malformed value onto the listing.
export function clampRelevance(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 0;
  return Math.min(9, Math.max(0, value));
}

interface RawFilterResultEntry {
  index: number;
  pass: boolean;
  reason: string | null;
  relevance?: unknown;
}

// Unlike relevance, there's no sensible value to coerce a malformed `pass` or
// `reason` into, so an entry with either field the wrong shape is dropped
// entirely — consistent with how an entry whose index doesn't resolve to a
// known listing is already dropped via the url filter below.
export function isValidFilterResultEntry(value: unknown): value is RawFilterResultEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.index === 'number' &&
    typeof candidate.pass === 'boolean' &&
    (candidate.reason === null ||
      candidate.reason === undefined ||
      typeof candidate.reason === 'string')
  );
}

export async function handleAiFilter(
  request: IncomingMessage,
  response: ServerResponse,
  cooldownStore: ProviderCooldownStore
): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let listings: Array<{
    url: string;
    title: string;
    price: string;
    location: string;
    description: string;
  }>;
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
  const queue = new ConcurrencyQueue(3);
  let rejectedCount = 0;

  const batches: (typeof listings)[] = [];
  for (let offset = 0; offset < listings.length; offset += BATCH_SIZE) {
    batches.push(listings.slice(offset, offset + BATCH_SIZE));
  }

  await Promise.all(
    batches.map((batch) =>
      queue.add(async () => {
        const numbered = batch
          .map(
            (listing, batchIndex) =>
              `${batchIndex + 1}. Title: "${listing.title}" | Price: ${listing.price} | Location: ${listing.location}${listing.description ? ` | Description: ${listing.description}` : ''}`
          )
          .join('\n');
        try {
          // Re-resolved fresh per batch (not hoisted) so a 429 on an earlier
          // batch actually rotates the remaining queued batches to the next
          // live provider instead of repeating the same doomed one.
          const aiConfig = getAIConfig(cooldownStore);
          const result = applyAiJsonResult(
            aiConfig.cooldownStore,
            await aiJSON(
              aiConfig,
              'ai-filter',
              AI_FILTER_SYSTEM_MESSAGE,
              `Criteria: ${prompt}\n\nListings:\n${numbered}`,
              4096
            )
          );
          if (typeof result !== 'object' || result === null)
            throw new Error('AI filter: expected object response');
          const resultObj = result as Record<string, unknown>;
          const parsed: unknown[] = Array.isArray(result)
            ? result
            : Array.isArray(resultObj.results)
              ? resultObj.results
              : [];
          const results = parsed
            .filter(isValidFilterResultEntry)
            .map((resultItem) => ({
              url: batch[resultItem.index - 1]?.url ?? '',
              pass: resultItem.pass,
              reason: resultItem.reason ?? null,
              relevance: clampRelevance(resultItem.relevance),
            }))
            .filter((resultItem) => resultItem.url);
          rejectedCount += results.filter((resultItem) => !resultItem.pass).length;
          sse(response, { type: 'result', results });
        } catch (err) {
          sse(response, { type: 'error', message: (err as Error).message });
        }
      })
    )
  );

  console.log(`[ai-filter] checked ${listings.length} listings, ${rejectedCount} rejected`);
  response.end();
}
