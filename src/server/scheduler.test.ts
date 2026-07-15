import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing, ProviderCooldownStore, QuickSearchEvent, Recipe } from '../lib/recipes/base';
import { makeListing } from '../lib/testFixtures';

vi.mock('./recipes/registry', () => ({ getRecipeForUrl: vi.fn() }));
vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>();
  return { ...actual, aiJSON: vi.fn(), getAIConfig: vi.fn() };
});
vi.mock('./imageAttachment', () => ({ fetchListingImageAttachmentAsync: vi.fn() }));

import { aiJSON, getAIConfig } from './ai';
import { hashFingerprintParts } from './alerts';
import {
  initSchema,
  stmtClearSearch,
  stmtCountAlertsForSavedSearch,
  stmtGetSavedSearch,
  stmtInsertSavedSearch,
} from './db';
import { fetchListingImageAttachmentAsync } from './imageAttachment';
import { getRecipeForUrl } from './recipes/registry';
import {
  AI_FILTER_TIMEOUT_MS,
  escapeSignalMarkdown,
  formatAlertMessage,
  NOTIFY_LOOP_TIMEOUT_MS,
  runSchedulerAsync,
  SCRAPE_TIMEOUT_MS,
} from './scheduler';

const STUB_COOLDOWN_STORE: ProviderCooldownStore = {
  markExhausted: () => {},
  getCooldownUntil: () => undefined,
};

const SEARCH_URL = 'https://example.com/marketplace/search';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function insertAlertSearch(
  db: Database.Database,
  overrides: {
    id?: string;
    name?: string;
    urls?: string[];
    aiFilter?: string | null;
    alertEnabled?: boolean;
  } = {}
): string {
  const id = overrides.id ?? 'search-1';
  stmtInsertSavedSearch(db).run(
    id,
    overrides.name ?? 'My search',
    JSON.stringify(overrides.urls ?? [SEARCH_URL]),
    null,
    overrides.aiFilter ?? null,
    Date.now(),
    overrides.alertEnabled === false ? 0 : 1
  );
  return id;
}

// Mirrors the pre-per-recipe-fingerprint shared hash (title+location+description+price)
// so existing dedup/relist-proof assertions below keep their original meaning.
function stubComputeAlertFingerprint(listing: Listing): string {
  return hashFingerprintParts([
    listing.title,
    listing.location,
    listing.description,
    listing.price,
  ]);
}

function makeStubRecipe(listings: Listing[]): Recipe {
  return {
    name: 'stub',
    matches: () => true,
    extractImplicitFilters: () => [],
    quickSearchAsync: async (_url: string, onEvent: (event: QuickSearchEvent) => void) => {
      for (const listing of listings) onEvent({ type: 'listing', data: listing });
      onEvent({ type: 'complete' });
    },
    deepSearchAsync: async () => {},
    computeAlertFingerprint: stubComputeAlertFingerprint,
  };
}

// Simulates a recipe stuck on a login wall / hung socket / unresolved
// promise — its quickSearchAsync call never settles either way.
function makeHangingRecipe(): Recipe {
  return {
    name: 'stub-hang',
    matches: () => true,
    extractImplicitFilters: () => [],
    quickSearchAsync: () => new Promise(() => {}),
    deepSearchAsync: async () => {},
    computeAlertFingerprint: stubComputeAlertFingerprint,
  };
}

beforeEach(() => {
  vi.mocked(getRecipeForUrl).mockReset();
  vi.mocked(aiJSON).mockReset();
  vi.mocked(getAIConfig).mockReset();
  vi.mocked(fetchListingImageAttachmentAsync).mockReset().mockResolvedValue(undefined);
});

describe('runSchedulerAsync', () => {
  it('is a population run for a saved search with no existing alerts: inserts alert rows without notifying', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );
    const sendNotificationAsync = vi.fn();

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).not.toHaveBeenCalled();
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(1);
  });

  it('notifies for a genuinely new listing on a saved search that already has alert history', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    // Seed alert history with a different listing so this is not a population run.
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const newListing = makeListing({ title: 'New chair', url: 'https://example.com/new' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, newListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(sendNotificationAsync.mock.calls[0][0]).toContain('New chair');
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(2);
  });

  it('does not re-enter population mode for a saved search whose alerted_listings rows were separately cleared, even though the row count is back to zero', async () => {
    // Regression test: isPopulationRun must be read from the persisted
    // has_completed_population_run flag, not re-derived from
    // stmtCountAlertsForSavedSearch — otherwise any unrelated event that
    // drops the count back to zero (a zero-row run, manual cleanup, etc.)
    // makes the next genuinely-new listing look like population-run
    // backfill and silently swallows the alert instead of notifying.
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    expect(stmtGetSavedSearch(db).get(searchId)?.has_completed_population_run).toBe(1);

    // Simulate the count dropping back to zero for reasons unrelated to
    // population state (e.g. a cleanup job, or the earlier bug this column
    // fixes) — the persisted flag must still say the population run is done.
    db.prepare('DELETE FROM alerted_listings WHERE saved_search_id = ?').run(searchId);
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(0);
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    // Only the genuinely new listing is scraped this run (the seed listing's
    // own alerted_listings row was cleared above too, but that's incidental
    // to this test — what's under test is that has_completed_population_run
    // alone, not the row count, decides population vs. notify mode).
    const newListing = makeListing({ title: 'New chair', url: 'https://example.com/new' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([newListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(sendNotificationAsync.mock.calls[0][0]).toContain('New chair');
  });

  it('rolls back the entire population baseline insert if an error occurs partway through, leaving no partial rows and the flag unset for a clean retry', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    const listingA = makeListing({ title: 'Chair', url: 'https://example.com/1' });
    const listingB = makeListing({ title: 'Table', url: 'https://example.com/2' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([listingA, listingB]));

    let nowCallCount = 0;
    const now = () => {
      nowCallCount++;
      if (nowCallCount === 2) throw new Error('simulated crash mid-population');
      return 1000;
    };

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      now,
    });

    // Neither listing was recorded — the transaction rolled back rather
    // than leaving the first listing's row committed on its own.
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(0);
    expect(stmtGetSavedSearch(db).get(searchId)?.has_completed_population_run).toBe(0);
  });

  it('does not re-notify for a listing that was already alerted', async () => {
    const db = freshDb();
    insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });

    // Second run: same seed listing plus one already-alerted-adjacent run again — no new listings.
    const sendNotificationAsync = vi.fn();
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).not.toHaveBeenCalled();
  });

  it('never notifies or records an alert for a sold listing', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    // Seed non-population history first.
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const soldListing = makeListing({
      title: 'Sold thing',
      url: 'https://example.com/sold',
      isSold: true,
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, soldListing]));
    const sendNotificationAsync = vi.fn();

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).not.toHaveBeenCalled();
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(1);
  });

  it('is relist-proof: a listing found again under a new URL id but same content does not re-alert', async () => {
    const db = freshDb();
    insertAlertSearch(db);
    const original = makeListing({
      title: 'Vintage lamp',
      url: 'https://example.com/listing/111',
      location: 'Wellington',
      price: 50,
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([original]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const relisted = makeListing({
      title: 'Vintage lamp',
      url: 'https://example.com/listing/222',
      location: 'Wellington',
      price: 50,
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([relisted]));
    const sendNotificationAsync = vi.fn();

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).not.toHaveBeenCalled();
  });

  it('skips the AI filter step entirely when the saved search has no aiFilter prompt', async () => {
    const db = freshDb();
    insertAlertSearch(db, { aiFilter: null });
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const newListing = makeListing({ title: 'New thing', url: 'https://example.com/new' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, newListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(getAIConfig).not.toHaveBeenCalled();
    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('only notifies for listings that pass the AI filter when aiFilter is set', async () => {
    const db = freshDb();
    insertAlertSearch(db, { aiFilter: 'laptop' });
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    vi.mocked(getAIConfig).mockReturnValue({
      url: 'a',
      model: 'm',
      apiKey: 'k',
      providerKey: 'a',
      cooldownStore: STUB_COOLDOWN_STORE,
    });
    vi.mocked(aiJSON).mockResolvedValue({
      kind: 'ok',
      value: { results: [{ index: 1, pass: true, reason: null, relevance: 5 }] },
    });
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const passListing = makeListing({ title: 'Gaming laptop', url: 'https://example.com/pass' });
    const failListing = makeListing({ title: 'Random chair', url: 'https://example.com/fail' });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([seedListing, passListing, failListing])
    );
    // Candidate order this run is [seedListing, passListing, failListing] — indices 1-3.
    vi.mocked(aiJSON).mockResolvedValue({
      kind: 'ok',
      value: {
        results: [
          { index: 1, pass: true, reason: null, relevance: 5 },
          { index: 2, pass: true, reason: null, relevance: 8 },
          { index: 3, pass: false, reason: 'not a laptop', relevance: 1 },
        ],
      },
    });
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(sendNotificationAsync.mock.calls[0][0]).toContain('Gaming laptop');
  });

  it('does not record an alert when the notification send fails, so it is retried next run', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const newListing = makeListing({ title: 'New thing', url: 'https://example.com/new' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, newListing]));
    const sendNotificationAsync = vi.fn().mockRejectedValue(new Error('openclaw unreachable'));

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(1);
    expect(summary.searches[0].errors.length).toBeGreaterThan(0);
  });

  it('a failed notification for one listing does not prevent others from being processed', async () => {
    const db = freshDb();
    insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const failsListing = makeListing({
      title: 'Fails to notify',
      url: 'https://example.com/fails',
    });
    const succeedsListing = makeListing({ title: 'Notifies fine', url: 'https://example.com/ok' });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([seedListing, failsListing, succeedsListing])
    );
    const sendNotificationAsync = vi.fn().mockImplementation(async (message: string) => {
      if (message.includes('Fails to notify')) throw new Error('boom');
    });

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(2);
  });

  it('alerts independently per saved search for the same physical listing', async () => {
    const db = freshDb();
    // A monotonic fake clock — real scheduler invocations are minutes apart
    // (cron-driven), but these calls run back-to-back with no real I/O
    // between them, so a wall-clock Date.now() could tie two last_run_at
    // writes to the same millisecond and make the rowid tiebreak stick to
    // one saved search. Strictly increasing timestamps sidestep that.
    let fakeNow = 1_000;
    const now = () => fakeNow++;
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    const searchA = insertAlertSearch(db, {
      id: 'search-a',
      urls: ['https://a.example.com/search'],
    });
    const searchB = insertAlertSearch(db, {
      id: 'search-b',
      urls: ['https://b.example.com/search'],
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    // One search is processed per call — two calls to cover both population runs,
    // so a later new listing goes through the notify path rather than being
    // silently backfilled.
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      now,
    });
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      now,
    });
    expect(stmtCountAlertsForSavedSearch(db).get(searchA)?.n).toBe(1);
    expect(stmtCountAlertsForSavedSearch(db).get(searchB)?.n).toBe(1);
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const shared = makeListing({ title: 'Shared item', url: 'https://example.com/shared' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, shared]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now,
    });
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now,
    });

    // The same physical listing surfaces via both saved searches and notifies for each.
    expect(sendNotificationAsync).toHaveBeenCalledTimes(2);
    expect(stmtCountAlertsForSavedSearch(db).get(searchA)?.n).toBe(2);
    expect(stmtCountAlertsForSavedSearch(db).get(searchB)?.n).toBe(2);
  });

  it('a saved search with no matching recipe for one of its URLs records an error but keeps processing', async () => {
    const db = freshDb();
    insertAlertSearch(db, { urls: ['https://unrecognized.example.com/search'] });
    vi.mocked(getRecipeForUrl).mockReturnValue(null);

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });

    expect(summary.searches[0].errors.length).toBeGreaterThan(0);
  });

  it('a saved search whose row causes a synchronous throw does not prevent other saved searches from being processed on a later run', async () => {
    const db = freshDb();
    // Corrupt urls column — JSON.parse(row.urls) throws synchronously inside processSavedSearchAsync.
    stmtInsertSavedSearch(db).run(
      'search-corrupt',
      'Corrupt search',
      'not valid json',
      null,
      null,
      Date.now(),
      1
    );
    const goodSearchId = insertAlertSearch(db, { id: 'search-good', name: 'Good search' });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );

    // First call picks the corrupt row (inserted first, both last_run_at are NULL).
    const firstSummary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    expect(firstSummary.searches).toHaveLength(1);
    expect(firstSummary.searches[0].savedSearchId).toBe('search-corrupt');
    expect(firstSummary.searches[0].errors.length).toBeGreaterThan(0);
    // The failure doesn't starve the search out of rotation — its last_run_at
    // still advances so the next run moves on to the good search.
    expect(stmtGetSavedSearch(db).get('search-corrupt')?.last_run_at).not.toBeNull();

    // Second call picks the good search — the corrupt one is no longer "oldest".
    const secondSummary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    expect(secondSummary.searches).toHaveLength(1);
    expect(secondSummary.searches[0].savedSearchId).toBe('search-good');
    expect(stmtCountAlertsForSavedSearch(db).get(goodSearchId)?.n).toBe(1);
    expect(secondSummary.searches[0].populatedCount).toBe(1);
  });

  it('processes only the alert-enabled saved search that was run longest ago', async () => {
    const db = freshDb();
    insertAlertSearch(db, { id: 'search-a', name: 'Search A' });
    insertAlertSearch(db, { id: 'search-b', name: 'Search B' });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );

    // Both start with last_run_at = NULL, so rowid (insertion order) breaks the
    // tie — search-a was inserted first and is picked.
    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });

    expect(summary.searches).toHaveLength(1);
    expect(summary.searches[0].savedSearchId).toBe('search-a');
  });

  it('sets last_run_at to the injected clock time after processing a saved search', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );
    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_at).toBeNull();

    const fixedNow = 1_700_000_000_000;
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      now: () => fixedNow,
    });

    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_at).toBe(fixedNow);
  });

  it('never selects a saved search with alerts disabled', async () => {
    const db = freshDb();
    insertAlertSearch(db, { id: 'search-disabled', alertEnabled: false });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });

    expect(summary.searches).toHaveLength(0);
  });

  it('returns no searches when there are no alert-enabled saved searches at all', async () => {
    const db = freshDb();

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });

    expect(summary.searches).toHaveLength(0);
  });

  it('times out a stalled scrape instead of hanging forever, recording an error and completing the run', async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      insertAlertSearch(db);
      vi.mocked(getRecipeForUrl).mockReturnValue(makeHangingRecipe());

      const summaryPromise = runSchedulerAsync({
        database: db,
        cooldownStore: STUB_COOLDOWN_STORE,
        sendNotificationAsync: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(SCRAPE_TIMEOUT_MS);
      const summary = await summaryPromise;

      expect(summary.searches).toHaveLength(1);
      expect(summary.searches[0].errors.some((error) => error.includes('timed out'))).toBe(true);
      expect(summary.searches[0].listingsFoundCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs progress and error events reported by the recipe during quick search, tagged with the recipe name', async () => {
    const db = freshDb();
    insertAlertSearch(db);
    const recipe: Recipe = {
      name: 'trademe',
      matches: () => true,
      extractImplicitFilters: () => [],
      quickSearchAsync: async (_url, onEvent) => {
        onEvent({ type: 'progress', phase: 'paging', page: 1, totalPages: 3 });
        onEvent({ type: 'error', message: 'boom' });
        onEvent({ type: 'complete' });
      },
      deepSearchAsync: async () => {},
      computeAlertFingerprint: stubComputeAlertFingerprint,
    };
    vi.mocked(getRecipeForUrl).mockReturnValue(recipe);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runSchedulerAsync({
        database: db,
        cooldownStore: STUB_COOLDOWN_STORE,
        sendNotificationAsync: vi.fn(),
      });

      expect(
        logSpy.mock.calls.some(
          ([message]) =>
            typeof message === 'string' &&
            message.includes('[trademe]') &&
            message.includes('page 1')
        )
      ).toBe(true);
      expect(
        errorSpy.mock.calls.some(
          ([message]) =>
            typeof message === 'string' && message.includes('[trademe]') && message.includes('boom')
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('times out a stalled AI filter run instead of hanging forever, recording an error and completing the run', async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      insertAlertSearch(db, { aiFilter: 'laptop' });
      const listing = makeListing({ title: 'Gaming laptop', url: 'https://example.com/pass' });
      vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([listing]));
      vi.mocked(getAIConfig).mockReturnValue({
        url: 'a',
        model: 'm',
        apiKey: 'k',
        providerKey: 'a',
        cooldownStore: STUB_COOLDOWN_STORE,
      });
      // Simulates a hung AI provider call — aiJSON's own promise never settles.
      vi.mocked(aiJSON).mockImplementation(() => new Promise(() => {}));

      const summaryPromise = runSchedulerAsync({
        database: db,
        cooldownStore: STUB_COOLDOWN_STORE,
        sendNotificationAsync: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(AI_FILTER_TIMEOUT_MS);
      const summary = await summaryPromise;

      expect(summary.searches).toHaveLength(1);
      expect(summary.searches[0].errors.some((error) => error.includes('timed out'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a stalled notify loop instead of hanging forever, recording an error and completing the run', async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      const searchId = insertAlertSearch(db);
      const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
      vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
      await runSchedulerAsync({
        database: db,
        cooldownStore: STUB_COOLDOWN_STORE,
        sendNotificationAsync: vi.fn(),
      });
      stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

      const newListing = makeListing({ title: 'New chair', url: 'https://example.com/new' });
      vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, newListing]));
      // Simulates a hung notifier — sendNotificationAsync's own promise never settles.
      const sendNotificationAsync = vi.fn().mockImplementation(() => new Promise(() => {}));

      const summaryPromise = runSchedulerAsync({
        database: db,
        cooldownStore: STUB_COOLDOWN_STORE,
        sendNotificationAsync,
      });
      await vi.advanceTimersByTimeAsync(NOTIFY_LOOP_TIMEOUT_MS);
      const summary = await summaryPromise;

      expect(summary.searches).toHaveLength(1);
      expect(summary.searches[0].errors.some((error) => error.includes('timed out'))).toBe(true);
      // Only the seed baseline is alerted — the hung listing's send never completed.
      expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the fetched thumbnail image through to the notifier when the listing has one', async () => {
    const db = freshDb();
    insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const listing = makeListing({
      title: 'Chair',
      url: 'https://example.com/1',
      thumbnailUrl: 'https://example.com/thumb.jpg',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, listing]));
    vi.mocked(fetchListingImageAttachmentAsync).mockResolvedValue('data:image/jpeg;base64,abc');
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(fetchListingImageAttachmentAsync).toHaveBeenCalledWith('https://example.com/thumb.jpg');
    expect(sendNotificationAsync.mock.calls[0][1]?.image).toBe('data:image/jpeg;base64,abc');
  });

  it('retries without the image when the notifier rejects an image-attached message, and marks the listing notified', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const listing = makeListing({
      title: 'Chair',
      url: 'https://example.com/1',
      thumbnailUrl: 'https://example.com/thumb.jpg',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, listing]));
    vi.mocked(fetchListingImageAttachmentAsync).mockResolvedValue('data:image/jpeg;base64,abc');
    const sendNotificationAsync = vi
      .fn()
      .mockRejectedValueOnce(new Error('Signal notification failed: 400 Bad Request'))
      .mockResolvedValueOnce(undefined);

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(2);
    expect(sendNotificationAsync.mock.calls[1][1]?.image).toBeUndefined();
    expect(summary.searches[0].notifiedCount).toBe(1);
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(2);
  });

  it('does not retry when the notifier rejects a message that never had an image attached', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const listing = makeListing({ title: 'Chair', url: 'https://example.com/1' }); // no thumbnailUrl
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, listing]));
    const sendNotificationAsync = vi.fn().mockRejectedValue(new Error('openclaw unreachable'));

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(summary.searches[0].notifiedCount).toBe(0);
    expect(summary.searches[0].errors.length).toBeGreaterThan(0);
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(1); // only the seed baseline
  });

  it('notifies with no image argument when the listing has no thumbnail', async () => {
    const db = freshDb();
    insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const listing = makeListing({ title: 'Chair', url: 'https://example.com/1' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, listing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(fetchListingImageAttachmentAsync).toHaveBeenCalledWith(undefined);
    expect(sendNotificationAsync.mock.calls[0][1]?.image).toBeUndefined();
  });
});

describe('formatAlertMessage', () => {
  it('composes the saved search name, bold title, source/location/price line, and url', () => {
    const listing = makeListing({
      source: 'trademe',
      title: 'Herman Miller Aeron, size B',
      price: 150,
      location: 'Wellington Central',
      url: 'https://www.trademe.co.nz/a/123456',
    });

    const message = formatAlertMessage('Chairs under $200', listing);

    expect(message).toBe(
      'Chairs under $200\n' +
        '**Herman Miller Aeron, size B**\n' +
        'Trade Me · Wellington Central · $150\n' +
        'https://www.trademe.co.nz/a/123456'
    );
  });

  it("renders 'Price on request' for a null price and the correct label per source", () => {
    const listing = makeListing({ source: 'facebook', price: null });

    const message = formatAlertMessage('My search', listing);

    expect(message).toContain('Facebook · Wellington · Price on request');
  });

  it('leaves the url untouched even if it contains markdown-special characters', () => {
    const listing = makeListing({ url: 'https://example.com/a_b*c?x=1~2' });

    const message = formatAlertMessage('My search', listing);

    expect(message.endsWith('https://example.com/a_b*c?x=1~2')).toBe(true);
  });

  it('escapes markdown-special characters in the title so they cannot break the bold wrapper', () => {
    const listing = makeListing({ title: 'Selling my **RARE** guitar' });

    const message = formatAlertMessage('My search', listing);

    // The only literal "**" pairs in the message must be the ones this
    // function itself added around the whole (escaped) title.
    expect(message.match(/\*\*/g)?.length).toBe(2);
  });

  it('does not let a leading/trailing * in the title merge with the bold wrapper into a *** run', () => {
    const listing = makeListing({ title: '*Rare* guitar' });

    const message = formatAlertMessage('My search', listing);

    expect(message).not.toMatch(/\*{3,}/);
  });
});

describe('escapeSignalMarkdown', () => {
  it('leaves plain text unchanged', () => {
    expect(escapeSignalMarkdown('Plain chair listing')).toBe('Plain chair listing');
  });

  it.each(['*', '_', '`', '~'])('strips adjacent pairs of %s entirely', (marker) => {
    const input = `a${marker}${marker}b`;
    const escaped = escapeSignalMarkdown(input);
    expect(escaped).not.toContain(marker);
  });

  it.each([
    '_',
    '`',
  ])('strips a single-character %s delimiter pair, not just spaces it apart', (marker) => {
    const input = `Cheap ${marker}car${marker} for sale`;
    const escaped = escapeSignalMarkdown(input);
    expect(escaped).not.toContain(marker);
  });
});
