import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing, QuickSearchEvent, Recipe } from '../../lib/recipes/base';
import { normalizeCachedListings } from './quickSearch';

let _testDb: Database.Database | null = null;

function requireTestDb(): Database.Database {
  if (!_testDb) throw new Error('test DB not initialised');
  return _testDb;
}

// Mirrors the `../db` mocking pattern used in savedSearches.test.ts, but keeps
// every real export (isFresh, ttlForListingCount, EMPTY_RESULT_CACHE_TTL_MS,
// initSchema, the prepared statements, ...) via `importOriginal` — only
// `getDb` is swapped for an in-memory instance, so the TTL/caching logic
// under test is the real implementation, not a re-encoding of it.
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, getDb: () => requireTestDb() };
});

vi.mock('../recipes/registry', () => ({ getRecipeForUrl: vi.fn() }));

import { EMPTY_RESULT_CACHE_TTL_MS, initSchema, stmtGetSearch } from '../db';
import { getRecipeForUrl } from '../recipes/registry';
import { handleQuickSearch, runQuickSearchForUrlAsync } from './quickSearch';

const SEARCH_URL = 'https://example.com/marketplace/search';

function initTestDb(): void {
  const db = new Database(':memory:');
  initSchema(db);
  _testDb = db;
}

function makeRequest(body: unknown = { url: SEARCH_URL }): IncomingMessage {
  const stream = new PassThrough();
  stream.end(JSON.stringify(body));
  return stream as unknown as IncomingMessage;
}

function makeResponse(): ServerResponse & { events: unknown[] } {
  const events: unknown[] = [];
  const response = {
    events,
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk: string) => {
      const match = chunk.match(/^data: (.*)\n\n$/);
      if (match) events.push(JSON.parse(match[1]));
      return true;
    },
    end: () => {},
    writeHead: () => {},
  } as unknown as ServerResponse & { events: unknown[] };
  return response;
}

function makeStubRecipe(
  quickSearchAsync: (url: string, onEvent: (event: QuickSearchEvent) => void) => Promise<void>
): Recipe {
  return {
    name: 'stub',
    matches: () => true,
    extractImplicitFilters: () => [],
    quickSearchAsync,
    deepSearchAsync: async () => {},
  };
}

const SAMPLE_LISTING: Listing = {
  source: 'facebook',
  title: 'Chair',
  price: 10,
  location: '',
  url: 'https://example.com/marketplace/item/1/',
  isAuction: false,
  relevance: 0,
};

beforeEach(() => {
  initTestDb();
  vi.mocked(getRecipeForUrl).mockReset();
});

describe('handleQuickSearch — caching a genuine empty completion', () => {
  it('caches a genuine zero-result completion (recipe reaches `complete` with no listings)', async () => {
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe(async (_url, onEvent) => {
        onEvent({ type: 'complete' });
      })
    );

    await handleQuickSearch(makeRequest(), makeResponse());

    const row = stmtGetSearch(requireTestDb()).get(SEARCH_URL);
    expect(row).toBeDefined();
    expect(row?.listing_count).toBe(0);
    expect(JSON.parse(row?.data ?? '[]')).toEqual([]);
  });

  it('does not cache an error/blocked outcome that never reaches `complete`, even though it also has zero listings', async () => {
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe(async (_url, onEvent) => {
        onEvent({
          type: 'error',
          message:
            'No listings found. Facebook may be blocking access or the search returned no results.',
        });
      })
    );

    await handleQuickSearch(makeRequest(), makeResponse());

    expect(stmtGetSearch(requireTestDb()).get(SEARCH_URL)).toBeUndefined();
  });

  it('still caches a populated completion as before', async () => {
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe(async (_url, onEvent) => {
        onEvent({ type: 'listing', data: SAMPLE_LISTING });
        onEvent({ type: 'complete' });
      })
    );

    await handleQuickSearch(makeRequest(), makeResponse());

    const row = stmtGetSearch(requireTestDb()).get(SEARCH_URL);
    expect(row?.listing_count).toBe(1);
  });

  it('serves a fresh empty-result cache entry on a repeat request without invoking the recipe again', async () => {
    const quickSearchAsync = vi.fn(
      async (_url: string, onEvent: (event: QuickSearchEvent) => void) => {
        onEvent({ type: 'complete' });
      }
    );
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe(quickSearchAsync));

    await handleQuickSearch(makeRequest(), makeResponse());
    expect(quickSearchAsync).toHaveBeenCalledTimes(1);

    const secondResponse = makeResponse();
    await handleQuickSearch(makeRequest(), secondResponse);

    expect(quickSearchAsync).toHaveBeenCalledTimes(1);
    expect(secondResponse.events).toContainEqual({ type: 'cached', age: expect.any(String) });
  });

  it('expires an empty-result cache entry sooner than the standard TTL — a repeat search past the short window re-invokes the recipe', async () => {
    vi.useFakeTimers();
    try {
      const quickSearchAsync = vi.fn(
        async (_url: string, onEvent: (event: QuickSearchEvent) => void) => {
          onEvent({ type: 'complete' });
        }
      );
      vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe(quickSearchAsync));

      await handleQuickSearch(makeRequest(), makeResponse());
      expect(quickSearchAsync).toHaveBeenCalledTimes(1);

      // Past the short empty-result TTL, but this same offset would still be well
      // inside the standard populated-result TTL — proves the empty entry expires
      // on its own shorter clock, not the long one used for populated results.
      vi.advanceTimersByTime(EMPTY_RESULT_CACHE_TTL_MS + 1000);

      await handleQuickSearch(makeRequest(), makeResponse());
      expect(quickSearchAsync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runQuickSearchForUrlAsync', () => {
  it('scrapes and caches on a miss, returning the collected listings', async () => {
    const recipe = makeStubRecipe(async (_url, onEvent) => {
      onEvent({ type: 'listing', data: SAMPLE_LISTING });
      onEvent({ type: 'complete' });
    });
    const events: unknown[] = [];

    const result = await runQuickSearchForUrlAsync(SEARCH_URL, recipe, requireTestDb(), (event) =>
      events.push(event)
    );

    expect(result).toEqual({ listings: [SAMPLE_LISTING], didCompleteSuccessfully: true });
    expect(events).toContainEqual({ type: 'listing', data: SAMPLE_LISTING });
    expect(stmtGetSearch(requireTestDb()).get(SEARCH_URL)?.listing_count).toBe(1);
  });

  it('serves a fresh cache entry without invoking the recipe again', async () => {
    const quickSearchAsync = vi.fn(
      async (_url: string, onEvent: (event: QuickSearchEvent) => void) => {
        onEvent({ type: 'listing', data: SAMPLE_LISTING });
        onEvent({ type: 'complete' });
      }
    );
    const recipe = makeStubRecipe(quickSearchAsync);

    await runQuickSearchForUrlAsync(SEARCH_URL, recipe, requireTestDb(), () => {});
    const secondResult = await runQuickSearchForUrlAsync(
      SEARCH_URL,
      recipe,
      requireTestDb(),
      () => {}
    );

    expect(quickSearchAsync).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual({ listings: [SAMPLE_LISTING], didCompleteSuccessfully: true });
  });

  it('does not cache when the search is cancelled mid-run', async () => {
    const recipe = makeStubRecipe(async (_url, onEvent) => {
      onEvent({ type: 'listing', data: SAMPLE_LISTING });
      onEvent({ type: 'complete' });
    });

    await runQuickSearchForUrlAsync(
      SEARCH_URL,
      recipe,
      requireTestDb(),
      () => {},
      () => true
    );

    expect(stmtGetSearch(requireTestDb()).get(SEARCH_URL)).toBeUndefined();
  });
});

describe('normalizeCachedListings', () => {
  it('leaves a listing with an existing relevance untouched', () => {
    const listing = { ...SAMPLE_LISTING, relevance: 7 };
    expect(normalizeCachedListings([listing])).toEqual([listing]);
  });

  it('defaults relevance to 0 for a pre-deploy cached row missing the field', () => {
    // Simulates a row cached before `relevance` became mandatory on `Listing` —
    // the field is simply absent, which the `as Listing[]` cast on
    // `JSON.parse` lets through the type system undetected.
    const staleRow = [{ ...SAMPLE_LISTING }];
    delete (staleRow[0] as Partial<Listing>).relevance;
    expect(staleRow[0].relevance).toBeUndefined();

    const normalized = normalizeCachedListings(staleRow as Listing[]);
    expect(normalized[0].relevance).toBe(0);
  });

  it('does not mutate the input array', () => {
    const staleRow = [{ ...SAMPLE_LISTING }];
    delete (staleRow[0] as Partial<Listing>).relevance;
    const original = JSON.parse(JSON.stringify(staleRow));
    normalizeCachedListings(staleRow as Listing[]);
    expect(staleRow).toEqual(original);
  });
});
