// Quick-search domain service — resolves a search URL to listings, using the
// on-disk cache when fresh. No HTTP types: reused by both the SSE route
// (routes/quickSearch.ts) and the headless scheduler (scheduler.ts).

import type Database from 'better-sqlite3';
import type { Listing, QuickSearchEvent, Recipe } from '../../lib/recipes/base';
import { cacheAge, isFresh, stmtGetSearch, stmtSetSearch, ttlForListingCount } from '../db';

// Cached rows may predate the `relevance` field (or any future required
// field) becoming mandatory on `Listing`. Default it on read so replaying a
// pre-deploy cache entry can't feed `undefined`/NaN into the sort comparator.
export function normalizeCachedListings(rawListings: Listing[]): Listing[] {
  return rawListings.map((listing) => ({ ...listing, relevance: listing.relevance ?? 0 }));
}

export type QuickSearchCacheEvent = QuickSearchEvent | { type: 'cached'; age: string };

export type QuickSearchRunResult = {
  listings: Listing[];
  didCompleteSuccessfully: boolean;
};

// Shared core reused by both the SSE route (routes/quickSearch.ts) and the
// headless scheduler (src/server/scheduler.ts): resolves a search URL to
// listings, transparently serving a fresh cache entry instead of re-scraping,
// and caching a genuine completion. `onEvent` carries every event a caller
// might want to relay (SSE streaming) or ignore (the scheduler only looks at
// `listing`).
export async function runQuickSearchForUrlAsync(
  url: string,
  recipe: Recipe,
  database: Database.Database,
  onEvent: (event: QuickSearchCacheEvent) => void,
  isCancelled?: () => boolean
): Promise<QuickSearchRunResult> {
  const cachedRow = stmtGetSearch(database).get(url);
  if (cachedRow && isFresh(cachedRow.cached_at, ttlForListingCount(cachedRow.listing_count))) {
    const age = cacheAge(cachedRow.cached_at);
    console.log(`[cache] search hit (${age})`);
    onEvent({ type: 'criteria', filters: recipe.extractImplicitFilters(url) });
    onEvent({ type: 'cached', age });
    const listings = normalizeCachedListings(JSON.parse(cachedRow.data) as Listing[]);
    for (const listing of listings) onEvent({ type: 'listing', data: listing });
    onEvent({ type: 'complete' });
    return { listings, didCompleteSuccessfully: true };
  }

  const listings: Listing[] = [];
  // Every recipe emits `{ type: 'complete' }` only once it has genuinely finished
  // searching — a login wall, block, or other failure emits `{ type: 'error' }`
  // and returns without ever reaching `complete` (see facebook.ts). Gating the
  // cache write on this instead of `listings.length > 0` lets a genuine
  // zero-result search be cached as a real success, without caching a
  // zero-listing error/blocked outcome as if it were one.
  let didCompleteSuccessfully = false;
  await recipe.quickSearchAsync(
    url,
    (event) => {
      if (event.type === 'listing') listings.push(event.data);
      if (event.type === 'complete') didCompleteSuccessfully = true;
      onEvent(event);
    },
    isCancelled
  );
  if (!(isCancelled?.() ?? false) && didCompleteSuccessfully) {
    stmtSetSearch(database).run(url, JSON.stringify(listings), Date.now(), listings.length);
    console.log(`[cache] stored ${listings.length} listings`);
  }
  return { listings, didCompleteSuccessfully };
}
