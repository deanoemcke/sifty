// Server-side only — POST /api/quick-search route handler.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Listing } from '../../lib/recipes/base';
import { requireString } from '../../lib/validate';
import { cancelSearch, cleanupSearch, isSearchCancelled, registerSearch } from '../cancellation';
import { cacheAge, getDb, isFresh, stmtGetSearch, stmtSetSearch, ttlForListingCount } from '../db';
import { readBody, sendJSON, sse, startSSE } from '../helpers';
import { getRecipeForUrl } from '../recipes/registry';

// Cached rows may predate the `relevance` field (or any future required
// field) becoming mandatory on `Listing`. Default it on read so replaying a
// pre-deploy cache entry can't feed `undefined`/NaN into the sort comparator.
export function normalizeCachedListings(rawListings: Listing[]): Listing[] {
  return rawListings.map((listing) => ({ ...listing, relevance: listing.relevance ?? 0 }));
}

export async function handleQuickSearch(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = await readBody(request).catch(() => null);

  let url: string;
  try {
    url = requireString((body as Record<string, unknown>)?.url, 'url');
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message });
    return;
  }

  const searchId = (body as Record<string, unknown>)?.searchId;
  const searchIdStr = typeof searchId === 'string' && searchId.trim() ? searchId : undefined;

  const recipe = getRecipeForUrl(url);
  if (!recipe) {
    sendJSON(response, 400, { error: 'No recipe found for this URL' });
    return;
  }

  const database = getDb();
  const cachedRow = stmtGetSearch(database).get(url);
  if (cachedRow && isFresh(cachedRow.cached_at, ttlForListingCount(cachedRow.listing_count))) {
    const age = cacheAge(cachedRow.cached_at);
    console.log(`[cache] search hit (${age})`);
    startSSE(response);
    sse(response, { type: 'criteria', filters: recipe.extractImplicitFilters(url) });
    sse(response, { type: 'cached', age });
    for (const listing of normalizeCachedListings(JSON.parse(cachedRow.data) as Listing[]))
      sse(response, { type: 'listing', data: listing });
    sse(response, { type: 'complete' });
    response.end();
    return;
  }

  startSSE(response);
  if (searchIdStr) {
    registerSearch(searchIdStr);
    request.on('close', () => cancelSearch(searchIdStr));
  }
  const isCancelled = () => (searchIdStr ? isSearchCancelled(searchIdStr) : false);
  const heartbeat = setInterval(() => {
    try {
      response.write(': heartbeat\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);
  const listings: Listing[] = [];
  // Every recipe emits `{ type: 'complete' }` only once it has genuinely finished
  // searching — a login wall, block, or other failure emits `{ type: 'error' }`
  // and returns without ever reaching `complete` (see facebook.ts). Gating the
  // cache write on this instead of `listings.length > 0` lets a genuine
  // zero-result search be cached as a real success, without caching a
  // zero-listing error/blocked outcome as if it were one.
  let didCompleteSuccessfully = false;

  try {
    await recipe.quickSearchAsync(
      url,
      (event) => {
        if (event.type === 'listing') listings.push(event.data);
        if (event.type === 'complete') didCompleteSuccessfully = true;
        try {
          sse(response, event);
        } catch {
          /* client disconnected */
        }
      },
      isCancelled
    );
    if (!isCancelled() && didCompleteSuccessfully) {
      stmtSetSearch(database).run(url, JSON.stringify(listings), Date.now(), listings.length);
      console.log(`[cache] stored ${listings.length} listings`);
    }
  } catch (err) {
    if (!isCancelled())
      try {
        sse(response, { type: 'error', message: (err as Error).message });
      } catch {
        /* ignore */
      }
  } finally {
    clearInterval(heartbeat);
    if (searchIdStr) cleanupSearch(searchIdStr);
    try {
      response.end();
    } catch {
      /* client already disconnected */
    }
  }
}
