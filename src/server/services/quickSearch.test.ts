import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing, QuickSearchEvent, Recipe } from '../../lib/recipes/base';
import { initSchema, stmtGetSearch } from '../db';
import { normalizeCachedListings, runQuickSearchForUrlAsync } from './quickSearch';

let _testDb: Database.Database | null = null;

function requireTestDb(): Database.Database {
  if (!_testDb) throw new Error('test DB not initialised');
  return _testDb;
}

function initTestDb(): void {
  const db = new Database(':memory:');
  initSchema(db);
  _testDb = db;
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
    computeAlertFingerprint: () => 'stub-fingerprint',
  };
}

const SEARCH_URL = 'https://example.com/marketplace/search';

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
