import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  stmtMarkAlertSetupNotificationPending,
  stmtMarkPopulationRunComplete,
  stmtUpdateSavedSearchLastRunAt,
} from './db';
import { fetchListingImageAttachmentAsync } from './imageAttachment';
import { getRecipeForUrl } from './recipes/registry';
import {
  AGGREGATED_FAILURE_DETAIL_MAX_LENGTH,
  AI_FILTER_TIMEOUT_MS,
  buildFailureComparisonKey,
  determineExitCode,
  FAILURE_REALERT_MS,
  NOTIFY_LOOP_TIMEOUT_MS,
  normalizeScrapeErrorReason,
  runImmediatePopulationRunAsync,
  runSchedulerAsync as runSchedulerAsyncUngated,
  SCRAPE_ERROR_REASON_MAX_LENGTH,
  SCRAPE_TIMEOUT_MS,
  type SchedulerDeps,
  type SchedulerSummary,
  STATUS_ALERT_TIMEOUT_MS,
  triggerImmediatePopulationRunAsync,
} from './scheduler';

const STUB_COOLDOWN_STORE: ProviderCooldownStore = {
  markExhausted: () => {},
  getCooldownUntil: () => undefined,
};

// Most tests below simulate successive scheduler ticks with back-to-back
// calls on the same (usually real) clock, expecting each call to immediately
// pick up whatever it just processed a moment ago — that's the pre-due-based
// "always pick the oldest" behaviour. Defaulting targetIntervalMs to 0 here
// keeps that intent intact; tests that specifically exercise the due-interval
// gate pass their own targetIntervalMs, which overrides this default.
function runSchedulerAsync(deps: SchedulerDeps) {
  return runSchedulerAsyncUngated({ targetIntervalMs: 0, ...deps });
}

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

// Simulates Facebook's login-wall detection firing after some DOM listings
// were already processed (facebook.ts's detectLoginWallAsync runs after the
// MutationObserver has already emitted `listing` events for already-rendered
// links) — some `listing` events fire, then `error`, and `complete` never
// fires. The error message mirrors the real shape emitted by
// detectLoginWallAsync's caller in facebook.ts, which embeds however many
// listings had loaded before the wall appeared — that count varies from run
// to run for what is otherwise the same underlying failure, which is exactly
// what normalizeScrapeErrorReason (scheduler.ts) exists to see through.
function makeLoginWalledRecipe(recipeName: string, listings: Listing[]): Recipe {
  return {
    name: recipeName,
    matches: () => true,
    extractImplicitFilters: () => [],
    quickSearchAsync: async (_url: string, onEvent: (event: QuickSearchEvent) => void) => {
      for (const listing of listings) onEvent({ type: 'listing', data: listing });
      onEvent({
        type: 'error',
        message: `Login wall detected — only ${listings.length} listing${listings.length !== 1 ? 's' : ''} loaded. Set the FB_COOKIES environment variable to get full results.`,
      });
    },
    deepSearchAsync: async () => {},
    computeAlertFingerprint: stubComputeAlertFingerprint,
  };
}

// Like makeLoginWalledRecipe, but with a caller-chosen reason, for tests that
// need to distinguish "same reason" from "different reason" suppression.
function makeFailingRecipeWithReason(recipeName: string, reason: string): Recipe {
  return {
    name: recipeName,
    matches: () => true,
    extractImplicitFilters: () => [],
    quickSearchAsync: async (_url: string, onEvent: (event: QuickSearchEvent) => void) => {
      onEvent({ type: 'error', message: reason });
    },
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

  it('passes a listing categoryPath through to the AI filter prompt', async () => {
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

    const newListing = makeListing({
      title: 'Gaming laptop',
      url: 'https://example.com/new',
      categoryPath: '/Computers/Laptops',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, newListing]));
    vi.mocked(aiJSON).mockClear();

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn().mockResolvedValue(undefined),
    });

    expect(vi.mocked(aiJSON).mock.calls[0][3]).toContain('| Category: Computers/Laptops');
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

  it('a failed notification for one listing does not prevent others from being processed, and does not falsely fail the search', async () => {
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

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    // Only the 2 listing sends (one fails, one succeeds) — a notify-kind
    // error is excluded from health, so it doesn't also trigger a false
    // failure-status alert.
    expect(sendNotificationAsync).toHaveBeenCalledTimes(2);
    expect(
      summary.searches[0].errors.some(
        (error) => error.kind === 'notify' && error.message.includes('https://example.com/fails')
      )
    ).toBe(true);
    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_succeeded).toBe(1);
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
      name: 'Search A',
      urls: ['https://a.example.com/search'],
    });
    const searchB = insertAlertSearch(db, {
      id: 'search-b',
      name: 'Search B',
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

    // maxSearchesPerTick: 1 keeps this test's cross-tick scenario meaningful —
    // otherwise both due (never-run) searches would be processed in one tick.
    // First call picks the corrupt row (inserted first, both last_run_at are NULL).
    const firstSummary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      maxSearchesPerTick: 1,
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
      maxSearchesPerTick: 1,
    });
    expect(secondSummary.searches).toHaveLength(1);
    expect(secondSummary.searches[0].savedSearchId).toBe('search-good');
    expect(stmtCountAlertsForSavedSearch(db).get(goodSearchId)?.n).toBe(1);
    expect(secondSummary.searches[0].populatedCount).toBe(1);
  });

  it('names the saved search and states the column is corrupted when urls is not valid JSON', async () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run(
      'search-corrupt',
      'Corrupt search',
      'not valid json',
      null,
      null,
      Date.now(),
      1
    );

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      maxSearchesPerTick: 1,
    });

    expect(summary.searches[0].errors[0].message).toContain(
      'Corrupted saved search "Corrupt search"'
    );
    expect(summary.searches[0].errors[0].message).toContain('urls column is not valid JSON');
  });

  it('names the saved search and states the column is the wrong shape when urls is valid JSON but not an array of strings', async () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run(
      'search-wrong-shape',
      'Wrong shape search',
      JSON.stringify([123, null]),
      null,
      null,
      Date.now(),
      1
    );

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      maxSearchesPerTick: 1,
    });

    expect(summary.searches[0].errors[0].message).toContain(
      'Corrupted saved search "Wrong shape search"'
    );
    expect(summary.searches[0].errors[0].message).toContain('did not parse to an array of strings');
  });

  it('processes only up to maxSearchesPerTick due searches, oldest first', async () => {
    const db = freshDb();
    insertAlertSearch(db, { id: 'search-a', name: 'Search A' });
    insertAlertSearch(db, { id: 'search-b', name: 'Search B' });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );

    // Both start with last_run_at = NULL, so rowid (insertion order) breaks the
    // tie — search-a was inserted first and is picked when the cap is 1.
    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      maxSearchesPerTick: 1,
    });

    expect(summary.searches).toHaveLength(1);
    expect(summary.searches[0].savedSearchId).toBe('search-a');
  });

  it('does not select a saved search whose last_run_at is within the target interval, even if others are due', async () => {
    const db = freshDb();
    const fixedNow = 1_700_000_000_000;
    const targetIntervalMs = 60 * 60_000;
    insertAlertSearch(db, { id: 'search-recent', name: 'Recent search' });
    insertAlertSearch(db, { id: 'search-old', name: 'Old search' });
    stmtUpdateSavedSearchLastRunAt(db).run(fixedNow - 10 * 60_000, 'search-recent');
    stmtUpdateSavedSearchLastRunAt(db).run(fixedNow - 90 * 60_000, 'search-old');
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      now: () => fixedNow,
      targetIntervalMs,
    });

    expect(summary.searches).toHaveLength(1);
    expect(summary.searches[0].savedSearchId).toBe('search-old');
  });

  it('processes multiple due searches in the same tick, up to maxSearchesPerTick', async () => {
    const db = freshDb();
    insertAlertSearch(db, { id: 'search-a', name: 'Search A' });
    insertAlertSearch(db, { id: 'search-b', name: 'Search B' });
    insertAlertSearch(db, { id: 'search-c', name: 'Search C' });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      maxSearchesPerTick: 2,
    });

    expect(summary.searches.map((search) => search.savedSearchId)).toEqual([
      'search-a',
      'search-b',
    ]);
    expect(stmtGetSavedSearch(db).get('search-c')?.last_run_at).toBeNull();
  });

  it('a synchronous throw from one search in a batch does not prevent the rest of that same tick from being processed', async () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run(
      'search-corrupt',
      'Corrupt search',
      'not valid json',
      null,
      null,
      Date.now(),
      1
    );
    insertAlertSearch(db, { id: 'search-good', name: 'Good search' });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      maxSearchesPerTick: 2,
    });

    expect(summary.searches).toHaveLength(2);
    const corrupt = summary.searches.find((search) => search.savedSearchId === 'search-corrupt');
    const good = summary.searches.find((search) => search.savedSearchId === 'search-good');
    expect(corrupt?.errors.length).toBeGreaterThan(0);
    expect(good?.errors).toHaveLength(0);
  });

  it('warns when more searches are due than maxSearchesPerTick can process, naming the backlog size', async () => {
    const db = freshDb();
    insertAlertSearch(db, { id: 'search-a', name: 'Search A' });
    insertAlertSearch(db, { id: 'search-b', name: 'Search B' });
    insertAlertSearch(db, { id: 'search-c', name: 'Search C' });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      maxSearchesPerTick: 2,
    });

    // Pins each number to its label rather than just checking that '3' and
    // '2' appear somewhere in the message — a transposed/off-by-one bug
    // (e.g. logging maxSearchesPerTick where rows.length belongs) would
    // still contain both digits and pass a looser stringContaining check.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /3 saved search\(es\) are due but only 2 were processed this tick \(maxSearchesPerTick=2\)/
      )
    );
    warnSpy.mockRestore();
  });

  it('does not warn when maxSearchesPerTick covers every due search', async () => {
    const db = freshDb();
    insertAlertSearch(db, { id: 'search-a', name: 'Search A' });
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
      maxSearchesPerTick: 2,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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
      expect(summary.searches[0].errors.some((error) => error.message.includes('timed out'))).toBe(
        true
      );
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
      expect(summary.searches[0].errors.some((error) => error.message.includes('timed out'))).toBe(
        true
      );
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
      // The notify-loop timeout above makes this run fail (first failure
      // since the earlier population run succeeded), so
      // recordSavedSearchRunStatusAndAlertAsync attempts its own status
      // alert next — via the same permanently-hung sendNotificationAsync
      // mock, so it needs its own timeout advanced too before it resolves.
      await vi.advanceTimersByTimeAsync(STATUS_ALERT_TIMEOUT_MS);
      const summary = await summaryPromise;

      expect(summary.searches).toHaveLength(1);
      expect(summary.searches[0].errors.some((error) => error.message.includes('timed out'))).toBe(
        true
      );
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

    // Only 1 listing send (no retry, since no image was ever attached) — a
    // notify-kind error is excluded from health, so it doesn't also trigger
    // a failure-status alert.
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

  it('discards partial listings and sends one failure Signal alert when a facebook-named recipe never completes (login wall)', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db, { name: 'FB search' });
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    }); // population run — establishes non-population history
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('facebook', [taintedListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    // This run's own scrape failure is the search's first failure since its
    // previous (population) run succeeded, so recordSavedSearchRunStatusAndAlertAsync alerts.
    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(sendNotificationAsync.mock.calls[0][0]).toBe(
      `Scrape error - FB search. Discarded 1 untrusted listing(s) from ${SEARCH_URL}: Login wall detected — only 1 listing loaded. Set the FBCOOKIES environment variable to get full results.`
    );
    expect(summary.searches[0].notifiedCount).toBe(0);
    expect(summary.searches[0].listingsFoundCount).toBe(0);
    // Only the run-1 seed baseline is alerted — the tainted listing never got recorded.
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(1);
    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_succeeded).toBe(0);
  });

  it('still notifies for a trademe listing on the same saved search when a facebook URL in it fails', async () => {
    const db = freshDb();
    const fbUrl = 'https://facebook.com/marketplace/search';
    const tmUrl = 'https://trademe.co.nz/search';
    const searchId = insertAlertSearch(db, { urls: [fbUrl, tmUrl] });
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    }); // population run
    stmtClearSearch(db).run();

    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    const newTmListing = makeListing({
      title: 'New trademe chair',
      url: 'https://trademe.co.nz/1',
    });
    vi.mocked(getRecipeForUrl).mockImplementation((url: string) =>
      url === fbUrl
        ? makeLoginWalledRecipe('facebook', [taintedListing])
        : makeStubRecipe([seedListing, newTmListing])
    );
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(
      sendNotificationAsync.mock.calls.some(([message]) => message.includes('New trademe chair'))
    ).toBe(true);
    expect(
      sendNotificationAsync.mock.calls.some(([message]) => message.includes('Tainted FB listing'))
    ).toBe(false);
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(2); // seed + new trademe listing
  });

  it('sends a proactive Signal notification for a non-facebook recipe that never completes too, not just facebook', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db, { name: 'TM search' });
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    }); // population run
    stmtClearSearch(db).run();

    const taintedListing = makeListing({
      title: 'Tainted listing',
      url: 'https://example.com/tainted',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('trademe', [taintedListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(sendNotificationAsync.mock.calls[0][0]).toBe(
      `Scrape error - TM search. Discarded 1 untrusted listing(s) from ${SEARCH_URL}: Login wall detected — only 1 listing loaded. Set the FBCOOKIES environment variable to get full results.`
    );
    expect(summary.searches[0].notifiedCount).toBe(0);
    expect(summary.searches[0].errors.some((error) => error.message.includes('Discarded'))).toBe(
      true
    );
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(1); // only the seed baseline
  });

  it('suppresses a repeat Signal alert for the same reason on the same saved search within 12h', async () => {
    const db = freshDb();
    insertAlertSearch(db, { name: 'FB search' });
    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('facebook', [taintedListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);
    const baseTime = Date.now();

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now: () => baseTime,
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now: () => baseTime + FAILURE_REALERT_MS - 1,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('re-sends a Signal alert for the same reason once the 12h suppression window has elapsed', async () => {
    const db = freshDb();
    insertAlertSearch(db, { name: 'FB search' });
    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('facebook', [taintedListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);
    const baseTime = Date.now();

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now: () => baseTime,
    });
    stmtClearSearch(db).run();

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now: () => baseTime + FAILURE_REALERT_MS,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(2);
  });

  it('does not suppress a genuinely different reason even within the 12h window', async () => {
    const db = freshDb();
    insertAlertSearch(db, { name: 'FB search' });
    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('facebook', [taintedListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);
    const baseTime = Date.now();

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now: () => baseTime,
    });
    stmtClearSearch(db).run();

    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeFailingRecipeWithReason('facebook', 'Rate limited by Facebook')
    );
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now: () => baseTime + 1_000,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(2);
  });

  it('sends a recovery alert when a previously-failing saved search succeeds, and resets its persisted failure state', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db, { name: 'FB search' });
    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('facebook', [taintedListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });
    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_succeeded).toBe(0);
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(2);
    expect(sendNotificationAsync.mock.calls[1][0]).toContain('working again');
    const row = stmtGetSavedSearch(db).get(searchId);
    expect(row?.last_run_succeeded).toBe(1);
    expect(row?.last_run_detail).toBeNull();
    expect(row?.last_failure_alerted_at).toBeNull();
  });

  it('does not re-send a recovery alert for a saved search that keeps succeeding', async () => {
    const db = freshDb();
    insertAlertSearch(db);
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).not.toHaveBeenCalled();
  });

  it("evaluates each saved search's success/failure independently within the same tick", async () => {
    const db = freshDb();
    insertAlertSearch(db, {
      id: 'search-fail',
      name: 'Search Fail',
      urls: ['https://facebook.com/marketplace/search'],
    });
    insertAlertSearch(db, {
      id: 'search-ok',
      name: 'Search OK',
      urls: ['https://example.com/marketplace/search'],
    });
    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    const okListing = makeListing({ title: 'Chair', url: 'https://example.com/1' });
    vi.mocked(getRecipeForUrl).mockImplementation((url: string) =>
      url.includes('facebook')
        ? makeLoginWalledRecipe('facebook', [taintedListing])
        : makeStubRecipe([okListing])
    );
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    // Only the failing search's first failure alerts — the succeeding one
    // (also its first-ever run) generates no alert, and each search's
    // persisted status reflects its own outcome, not the other's.
    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(sendNotificationAsync.mock.calls[0][0]).toContain('Search Fail');
    expect(stmtGetSavedSearch(db).get('search-fail')?.last_run_succeeded).toBe(0);
    expect(stmtGetSavedSearch(db).get('search-ok')?.last_run_succeeded).toBe(1);
  });

  it('caps an overlong scrape-failure reason before it flows into the outbound Signal alert or last_run_detail', async () => {
    // Matches the existing 200-char precedent in ai.ts (AI parse-error
    // messages) — an unusually long or malformed error message must not
    // flow uncapped into last_run_detail or an outbound Signal payload.
    const db = freshDb();
    const searchId = insertAlertSearch(db, { name: 'FB search' });
    const overlongReason = `Login wall detected — ${'x'.repeat(50)} listings loaded, url=https://facebook.com/marketplace/${'y'.repeat(200)}`;
    expect(overlongReason.length).toBeGreaterThan(SCRAPE_ERROR_REASON_MAX_LENGTH);
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeFailingRecipeWithReason('facebook', overlongReason)
    );
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    // The outbound Signal message never includes the uncapped tail.
    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    const message = sendNotificationAsync.mock.calls[0][0] as string;
    expect(message).not.toContain(overlongReason);
    expect(message).toContain(overlongReason.slice(0, SCRAPE_ERROR_REASON_MAX_LENGTH));

    // last_run_detail — the new per-search persisted failure text — is capped too.
    const detail = stmtGetSavedSearch(db).get(searchId)?.last_run_detail;
    expect(detail).not.toContain(overlongReason);
    expect(detail).toContain(overlongReason.slice(0, SCRAPE_ERROR_REASON_MAX_LENGTH));
  });

  it('caps the aggregated error text across multiple failures before it flows into the outbound Signal alert or last_run_detail', async () => {
    // A single overlong reason is already bounded at capture
    // (SCRAPE_ERROR_REASON_MAX_LENGTH), but summary.errors was designed as an
    // internal diagnostic list, not an external payload — nothing previously
    // bounded the *aggregate* once several such per-URL failures (each
    // already individually capped) are joined together for last_run_detail
    // and the outbound Signal message.
    const urls = Array.from(
      { length: 12 },
      (_, i) => `https://facebook.com/marketplace/search-${i}`
    );
    const db = freshDb();
    const searchId = insertAlertSearch(db, { urls });
    const reason = 'x'.repeat(SCRAPE_ERROR_REASON_MAX_LENGTH);
    vi.mocked(getRecipeForUrl).mockImplementation(() =>
      makeFailingRecipeWithReason('facebook', reason)
    );
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    // Sanity check: joining all 12 per-URL failures uncapped would comfortably
    // exceed the aggregate cap, so this test actually exercises the new bound.
    expect(urls.length * reason.length).toBeGreaterThan(AGGREGATED_FAILURE_DETAIL_MAX_LENGTH);

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    const message = sendNotificationAsync.mock.calls[0][0] as string;
    expect(message.length).toBeLessThanOrEqual(AGGREGATED_FAILURE_DETAIL_MAX_LENGTH);

    const detail = stmtGetSavedSearch(db).get(searchId)?.last_run_detail as string;
    expect(detail.length).toBeLessThanOrEqual(AGGREGATED_FAILURE_DETAIL_MAX_LENGTH);
  });

  it('suppresses a repeat login-wall alert even though the listing count embedded in the message differs between runs', async () => {
    // Mirrors facebook.ts's real login-wall message, which reports however
    // many listings had loaded before the wall appeared — a count that
    // varies run to run even though the underlying failure (no FB_COOKIES)
    // hasn't changed. Without normalizing that count out of the suppression
    // key, this exact case — the one the suppression table exists for — would
    // never actually suppress.
    const db = freshDb();
    insertAlertSearch(db, { name: 'FB search' });
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);
    const baseTime = Date.now();

    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeLoginWalledRecipe('facebook', [
        makeListing({ title: 'Listing A', url: 'https://facebook.com/a' }),
        makeListing({ title: 'Listing B', url: 'https://facebook.com/b' }),
        makeListing({ title: 'Listing C', url: 'https://facebook.com/c' }),
      ])
    );
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now: () => baseTime,
    });
    stmtClearSearch(db).run();

    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeLoginWalledRecipe('facebook', [
        makeListing({ title: 'Listing A', url: 'https://facebook.com/a' }),
        makeListing({ title: 'Listing D', url: 'https://facebook.com/d' }),
        makeListing({ title: 'Listing E', url: 'https://facebook.com/e' }),
        makeListing({ title: 'Listing F', url: 'https://facebook.com/f' }),
        makeListing({ title: 'Listing G', url: 'https://facebook.com/g' }),
      ])
    );
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
      now: () => baseTime + FAILURE_REALERT_MS - 1,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a different saved search's first-ever timeout failure, even though it shares the same underlying reason as an earlier alert", async () => {
    // Suppression (see recordSavedSearchRunStatusAndAlertAsync) is scoped
    // per saved search, deliberately not shared across searches — search-b
    // failing for the first time must always alert, regardless of what
    // search-a already experienced and was alerted for.
    vi.useFakeTimers();
    try {
      const db = freshDb();
      insertAlertSearch(db, {
        id: 'search-a',
        name: 'Search A',
        urls: ['https://example.com/marketplace/search-a'],
      });
      vi.mocked(getRecipeForUrl).mockReturnValue(makeHangingRecipe());
      const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

      const firstRunPromise = runSchedulerAsync({
        database: db,
        cooldownStore: STUB_COOLDOWN_STORE,
        sendNotificationAsync,
      });
      await vi.advanceTimersByTimeAsync(SCRAPE_TIMEOUT_MS);
      await firstRunPromise;

      insertAlertSearch(db, {
        id: 'search-b',
        name: 'Search B',
        urls: ['https://example.com/marketplace/search-b'],
      });
      // search-a already ran once and isn't due again for ages — pass a huge
      // interval so only never-run search-b is picked up this tick, keeping
      // this test to a single SCRAPE_TIMEOUT_MS advance.
      const secondRunPromise = runSchedulerAsync({
        database: db,
        cooldownStore: STUB_COOLDOWN_STORE,
        sendNotificationAsync,
        targetIntervalMs: Number.MAX_SAFE_INTEGER,
      });
      await vi.advanceTimersByTimeAsync(SCRAPE_TIMEOUT_MS);
      await secondRunPromise;

      // search-a's first failure alerts, and search-b's first failure alerts
      // independently too — per-search state, not a shared reason-text table.
      expect(sendNotificationAsync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends an independent first-failure alert for each saved search that fails in the same tick, even sharing the same underlying reason', async () => {
    const db = freshDb();
    insertAlertSearch(db, { id: 'search-a', name: 'Search A' });
    insertAlertSearch(db, { id: 'search-b', name: 'Search B' });
    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('facebook', [taintedListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(2);
    expect(sendNotificationAsync.mock.calls.some(([message]) => message.includes('Search A'))).toBe(
      true
    );
    expect(sendNotificationAsync.mock.calls.some(([message]) => message.includes('Search B'))).toBe(
      true
    );
    expect(summary.searches[0].errors.some((error) => error.message.includes('Discarded'))).toBe(
      true
    );
    expect(summary.searches[1].errors.some((error) => error.message.includes('Discarded'))).toBe(
      true
    );
  });

  it('leaves has_completed_population_run unset when a URL is discarded during a population run, so the full baseline retries next tick', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db, { name: 'FB search' });
    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('facebook', [taintedListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    const summary = await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(summary.searches[0].isPopulationRun).toBe(true);
    // The flag must stay unset — not just "not incorrectly set to 1" — so the
    // next tick still sees this as a population run and retries the full
    // baseline, rather than treating the tainted URL's future listings as new.
    expect(stmtGetSavedSearch(db).get(searchId)?.has_completed_population_run).toBe(0);
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(0);
    expect(
      summary.searches[0].errors.some((error) =>
        error.message.includes('Population run incomplete')
      )
    ).toBe(true);
  });

  it('leaves the whole saved search in population mode when only one of several URLs fails during the population run, even though another URL succeeded', async () => {
    const db = freshDb();
    const fbUrl = 'https://facebook.com/marketplace/search';
    const tmUrl = 'https://trademe.co.nz/search';
    const searchId = insertAlertSearch(db, { urls: [fbUrl, tmUrl] });
    const taintedListing = makeListing({
      title: 'Tainted FB listing',
      url: 'https://facebook.com/x',
    });
    const tmListing = makeListing({ title: 'New trademe chair', url: 'https://trademe.co.nz/1' });
    vi.mocked(getRecipeForUrl).mockImplementation((url: string) =>
      url === fbUrl
        ? makeLoginWalledRecipe('facebook', [taintedListing])
        : makeStubRecipe([tmListing])
    );
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(stmtGetSavedSearch(db).get(searchId)?.has_completed_population_run).toBe(0);
    // Neither URL's listings are baselined this run — not even trademe's,
    // which succeeded — because the population run as a whole retries next
    // tick rather than partially completing.
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(0);
  });

  // Regression coverage for the success/failure "setup moment" gate staying
  // in sync: alert_setup_notification_pending can in principle still be set
  // on a row whose population run has already completed by the time it's
  // finally consumed (e.g. a cron tick that fetched the row just before the
  // pending flag was written misses it, and the *next* tick to see the flag
  // is an ordinary post-population run). That run is not a genuine
  // "finishing alert setup" moment, so neither the success nor the failure
  // branch should use the setup-specific message for it — both must agree.
  it('does not use the setup-failure message for an ordinary run that merely has a stale pending setup flag and is not itself a population run', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db, { name: 'FB search' });
    stmtMarkPopulationRunComplete(db).run(searchId);
    stmtMarkAlertSetupNotificationPending(db).run(searchId);
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('facebook', []));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(sendNotificationAsync.mock.calls[0][0]).not.toContain("Couldn't set up alerts");
    expect(sendNotificationAsync.mock.calls[0][0]).toContain('Scrape error');
  });

  it('does not use the setup-success message for an ordinary run that merely has a stale pending setup flag and is not itself a population run', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db, { name: 'FB search' });
    stmtMarkPopulationRunComplete(db).run(searchId);
    stmtMarkAlertSetupNotificationPending(db).run(searchId);
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    // No listings, no prior failure to recover from, and this run is not a
    // population run — nothing should be sent, and in particular not an
    // "Alerts set up" confirmation claiming a baseline that was never taken
    // this run.
    expect(sendNotificationAsync).not.toHaveBeenCalled();
  });
});

function tempLockPath(): string {
  return path.join(
    os.tmpdir(),
    `sifty-scheduler-immediate-test-${Date.now()}-${Math.random()}.lock`
  );
}

describe('runImmediatePopulationRunAsync', () => {
  let lockPath: string;

  beforeEach(() => {
    lockPath = tempLockPath();
  });

  afterEach(() => {
    if (lockPath && fs.existsSync(lockPath)) fs.rmSync(lockPath);
  });

  it('redoes the population pass even when has_completed_population_run is already 1, sending one setup-success alert but no per-listing alerts', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    // First run establishes history the normal way (population run).
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    expect(stmtGetSavedSearch(db).get(searchId)?.has_completed_population_run).toBe(1);
    stmtClearSearch(db).run(); // force a fresh scrape instead of serving the first run's cache

    const newListing = makeListing({ title: 'New chair', url: 'https://example.com/new' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing, newListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runImmediatePopulationRunAsync(
      searchId,
      { database: db, cooldownStore: STUB_COOLDOWN_STORE, sendNotificationAsync },
      lockPath
    );

    // Redone as a silent population pass: no per-listing notification, both
    // listings recorded (the pre-existing one via INSERT OR IGNORE, left
    // untouched; the new one added silently), flag still set — but the
    // immediate trigger itself sends one "alerts are set up" confirmation.
    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(sendNotificationAsync.mock.calls[0][0]).not.toContain('New chair');
    expect(sendNotificationAsync.mock.calls[0][0]).toContain('Alerts set up');
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(2);
    expect(stmtGetSavedSearch(db).get(searchId)?.has_completed_population_run).toBe(1);
  });

  it('leaves pre-existing alerted_listings rows untouched', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    const beforeRow = db
      .prepare('SELECT created_at FROM alerted_listings WHERE saved_search_id = ?')
      .get(searchId) as { created_at: number };
    stmtClearSearch(db).run();
    vi.mocked(getRecipeForUrl).mockReturnValue(makeStubRecipe([seedListing]));

    await runImmediatePopulationRunAsync(
      searchId,
      { database: db, cooldownStore: STUB_COOLDOWN_STORE, sendNotificationAsync: vi.fn() },
      lockPath
    );

    const afterRow = db
      .prepare('SELECT created_at FROM alerted_listings WHERE saved_search_id = ?')
      .get(searchId) as { created_at: number };
    expect(afterRow.created_at).toBe(beforeRow.created_at);
  });

  it('updates last_run_at', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );
    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_at).toBeNull();

    await runImmediatePopulationRunAsync(
      searchId,
      { database: db, cooldownStore: STUB_COOLDOWN_STORE, sendNotificationAsync: vi.fn() },
      lockPath
    );

    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_at).not.toBeNull();
  });

  it('resolves without running a population pass when the lock is already held, but marks the setup notification as pending so a later run still sends it', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid));

    await expect(
      runImmediatePopulationRunAsync(
        searchId,
        { database: db, cooldownStore: STUB_COOLDOWN_STORE },
        lockPath
      )
    ).resolves.toBeUndefined();

    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_at).toBeNull();
    expect(stmtCountAlertsForSavedSearch(db).get(searchId)?.n).toBe(0);
    // Deferring must not silently drop the setup confirmation forever (see
    // recordSavedSearchRunStatusAndAlertAsync) — the row is marked pending
    // so whichever run processes it next still sends one.
    expect(stmtGetSavedSearch(db).get(searchId)?.alert_setup_notification_pending).toBe(1);
  });

  it('resolves without throwing when the saved search no longer exists', async () => {
    const db = freshDb();

    await expect(
      runImmediatePopulationRunAsync(
        'missing-id',
        { database: db, cooldownStore: STUB_COOLDOWN_STORE },
        lockPath
      )
    ).resolves.toBeUndefined();
  });

  it('releases the lock after finishing, so a subsequent call can acquire it', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );

    await runImmediatePopulationRunAsync(
      searchId,
      { database: db, cooldownStore: STUB_COOLDOWN_STORE, sendNotificationAsync: vi.fn() },
      lockPath
    );

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('advances last_run_at even when processing throws, so a corrupted saved search does not get stuck retrying forever', async () => {
    const db = freshDb();
    // Corrupt urls column — JSON.parse(row.urls) throws synchronously inside processSavedSearchAsync,
    // mirroring the batch-path scenario in the 'a saved search whose row causes a synchronous throw...' test above.
    stmtInsertSavedSearch(db).run(
      'search-corrupt',
      'Corrupt search',
      'not valid json',
      null,
      null,
      Date.now(),
      1
    );

    await runImmediatePopulationRunAsync(
      'search-corrupt',
      { database: db, cooldownStore: STUB_COOLDOWN_STORE, sendNotificationAsync: vi.fn() },
      lockPath
    );

    expect(stmtGetSavedSearch(db).get('search-corrupt')?.last_run_at).not.toBeNull();
  });

  it('releases the lock even when processing throws', async () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run(
      'search-corrupt',
      'Corrupt search',
      'not valid json',
      null,
      null,
      Date.now(),
      1
    );

    await runImmediatePopulationRunAsync(
      'search-corrupt',
      { database: db, cooldownStore: STUB_COOLDOWN_STORE, sendNotificationAsync: vi.fn() },
      lockPath
    );

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('persists failure status and sends a failure alert when the population scrape fails', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db, { name: 'FB search' });
    vi.mocked(getRecipeForUrl).mockReturnValue(makeLoginWalledRecipe('facebook', []));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runImmediatePopulationRunAsync(
      searchId,
      { database: db, cooldownStore: STUB_COOLDOWN_STORE, sendNotificationAsync },
      lockPath
    );

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(sendNotificationAsync.mock.calls[0][0]).toContain('FB search');
    const row = stmtGetSavedSearch(db).get(searchId);
    expect(row?.last_run_succeeded).toBe(0);
    expect(row?.last_run_detail).toContain('Login wall detected');
  });

  it('persists failure status and sends a failure alert when processing throws synchronously', async () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run(
      'search-corrupt',
      'Corrupt search',
      'not valid json',
      null,
      null,
      Date.now(),
      1
    );
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);

    await runImmediatePopulationRunAsync(
      'search-corrupt',
      { database: db, cooldownStore: STUB_COOLDOWN_STORE, sendNotificationAsync },
      lockPath
    );

    expect(sendNotificationAsync).toHaveBeenCalledTimes(1);
    const row = stmtGetSavedSearch(db).get('search-corrupt');
    expect(row?.last_run_succeeded).toBe(0);
    expect(row?.last_run_detail).toContain('Unhandled error');
  });

  it('still sends the "Alerts set up" confirmation via the next scheduler tick when the immediate run is deferred by a contended lock, and does not resend it once consumed', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    vi.mocked(getRecipeForUrl).mockReturnValue(
      makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })])
    );
    // Simulate the lock already held by a real cron tick in progress.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid));

    const deferredSendNotificationAsync = vi.fn().mockResolvedValue(undefined);
    await runImmediatePopulationRunAsync(
      searchId,
      {
        database: db,
        cooldownStore: STUB_COOLDOWN_STORE,
        sendNotificationAsync: deferredSendNotificationAsync,
      },
      lockPath
    );

    // Deferred: no notification sent yet, no run recorded — matches the
    // pre-existing "defers gracefully" contract.
    expect(deferredSendNotificationAsync).not.toHaveBeenCalled();
    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_at).toBeNull();

    // The cron tick that was holding the lock finishes and releases it; the
    // next real tick then picks this saved search up as an ordinary due
    // population run — isImmediateSetupRun is never set on this path.
    fs.rmSync(lockPath);
    const tickSendNotificationAsync = vi.fn().mockResolvedValue(undefined);
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: tickSendNotificationAsync,
    });

    // The setup confirmation still arrives — carried forward by the pending
    // flag set at deferral time, not by isImmediateSetupRun.
    expect(tickSendNotificationAsync).toHaveBeenCalledTimes(1);
    expect(tickSendNotificationAsync.mock.calls[0][0]).toContain('Alerts set up');

    // Consumed: a later tick that reprocesses the same (now-populated)
    // search must not resend the confirmation a second time.
    tickSendNotificationAsync.mockClear();
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: tickSendNotificationAsync,
    });
    expect(tickSendNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('triggerImmediatePopulationRunAsync', () => {
  let lockPath: string;

  beforeEach(() => {
    lockPath = tempLockPath();
  });

  afterEach(() => {
    if (lockPath && fs.existsSync(lockPath)) fs.rmSync(lockPath);
  });

  it('never throws synchronously, even if the underlying run eventually rejects', async () => {
    const db = freshDb();
    // Corrupt urls column makes processSavedSearchAsync throw synchronously.
    stmtInsertSavedSearch(db).run(
      'search-corrupt',
      'Corrupt',
      'not valid json',
      null,
      null,
      Date.now(),
      1
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() =>
        triggerImmediatePopulationRunAsync(
          'search-corrupt',
          { database: db, cooldownStore: STUB_COOLDOWN_STORE },
          lockPath
        )
      ).not.toThrow();
      // Give the fire-and-forget promise a tick to settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('is fire-and-forget: returns before the underlying population run completes', async () => {
    const db = freshDb();
    const searchId = insertAlertSearch(db);
    let resolveScrape: () => void = () => {};
    const blockedRecipe: Recipe = {
      name: 'blocked',
      matches: () => true,
      extractImplicitFilters: () => [],
      quickSearchAsync: async (_url, onEvent) => {
        await new Promise<void>((resolve) => {
          resolveScrape = resolve;
        });
        onEvent({ type: 'complete' });
      },
      deepSearchAsync: async () => {},
      computeAlertFingerprint: stubComputeAlertFingerprint,
    };
    vi.mocked(getRecipeForUrl).mockReturnValue(blockedRecipe);

    const returnValue = triggerImmediatePopulationRunAsync(
      searchId,
      { database: db, cooldownStore: STUB_COOLDOWN_STORE },
      lockPath
    );

    expect(returnValue).toBeUndefined();
    // The scrape hasn't resolved yet, so last_run_at must still be unset.
    expect(stmtGetSavedSearch(db).get(searchId)?.last_run_at).toBeNull();
    resolveScrape();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('defers a second immediate-run request for a different saved search while the first still holds the lock, then leaves it to a later cron tick rather than retrying it automatically', async () => {
    const db = freshDb();
    const searchAId = insertAlertSearch(db, {
      id: 'search-a',
      name: 'Search A',
      urls: ['https://example.com/a'],
    });
    const searchBId = insertAlertSearch(db, {
      id: 'search-b',
      name: 'Search B',
      urls: ['https://example.com/b'],
    });
    let resolveScrapeA: () => void = () => {};
    const blockedRecipeA: Recipe = {
      name: 'blocked-a',
      matches: () => true,
      extractImplicitFilters: () => [],
      quickSearchAsync: async (_url, onEvent) => {
        await new Promise<void>((resolve) => {
          resolveScrapeA = resolve;
        });
        onEvent({ type: 'complete' });
      },
      deepSearchAsync: async () => {},
      computeAlertFingerprint: stubComputeAlertFingerprint,
    };
    const recipeB = makeStubRecipe([makeListing({ title: 'Chair', url: 'https://example.com/1' })]);
    vi.mocked(getRecipeForUrl).mockImplementation((url: string) =>
      url === 'https://example.com/a' ? blockedRecipeA : recipeB
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Fired back-to-back with no await in between: search-a's synchronous
    // lock acquisition happens before search-b's call even starts, since
    // acquireSchedulerLock uses sync fs calls (schedulerLock.ts).
    triggerImmediatePopulationRunAsync(
      searchAId,
      { database: db, cooldownStore: STUB_COOLDOWN_STORE },
      lockPath
    );
    triggerImmediatePopulationRunAsync(
      searchBId,
      { database: db, cooldownStore: STUB_COOLDOWN_STORE },
      lockPath
    );
    // Let both fire-and-forget runs progress to their next suspension point.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // search-b found the lock held by search-a and deferred rather than
    // waiting for it — no run recorded, a deferral message logged.
    expect(stmtGetSavedSearch(db).get(searchBId)?.last_run_at).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`${searchBId} deferred`));

    resolveScrapeA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // search-a, which held the lock, completes normally.
    expect(stmtGetSavedSearch(db).get(searchAId)?.last_run_at).not.toBeNull();
    // search-b is not automatically retried by the deferred call itself —
    // it's left for the next real cron tick to pick up, per the documented
    // "defers gracefully" behaviour in runImmediatePopulationRunAsync.
    expect(stmtGetSavedSearch(db).get(searchBId)?.last_run_at).toBeNull();

    logSpy.mockRestore();
  });
});

describe('normalizeScrapeErrorReason', () => {
  it('collapses reasons that differ only by an embedded count to the same key', () => {
    const a =
      'Login wall detected — only 3 listings loaded. Set the FB_COOKIES environment variable to get full results.';
    const b =
      'Login wall detected — only 47 listings loaded. Set the FB_COOKIES environment variable to get full results.';

    expect(normalizeScrapeErrorReason(a)).toBe(normalizeScrapeErrorReason(b));
  });

  it('collapses reasons that differ only by an embedded URL to the same key', () => {
    const a = 'Quick search for https://facebook.com/marketplace/search-a timed out after 30000ms';
    const b = 'Quick search for https://facebook.com/marketplace/search-b timed out after 30000ms';

    expect(normalizeScrapeErrorReason(a)).toBe(normalizeScrapeErrorReason(b));
  });

  it('does not collapse genuinely different failure categories', () => {
    const loginWall = 'Login wall detected — only 3 listings loaded.';
    const rateLimited = 'Rate limited by Facebook';

    expect(normalizeScrapeErrorReason(loginWall)).not.toBe(normalizeScrapeErrorReason(rateLimited));
  });
});

describe('buildFailureComparisonKey', () => {
  it('is order-independent: the same messages in a different order produce the same key', () => {
    const a = ['AI filter: batch 1 timed out', 'AI filter: batch 2 timed out'];
    const b = ['AI filter: batch 2 timed out', 'AI filter: batch 1 timed out'];

    expect(buildFailureComparisonKey(a)).toBe(buildFailureComparisonKey(b));
  });

  it('collapses duplicate messages so a repeated error does not change the key', () => {
    const withDuplicate = ['AI filter: batch timed out', 'AI filter: batch timed out'];
    const withoutDuplicate = ['AI filter: batch timed out'];

    expect(buildFailureComparisonKey(withDuplicate)).toBe(
      buildFailureComparisonKey(withoutDuplicate)
    );
  });

  it('still differentiates genuinely different error sets', () => {
    const a = ['AI filter: batch 1 timed out', 'AI filter: batch 2 timed out'];
    const b = ['AI filter: batch 1 timed out', 'Rate limited by Facebook'];

    expect(buildFailureComparisonKey(a)).not.toBe(buildFailureComparisonKey(b));
  });
});

describe('determineExitCode', () => {
  function makeSearchSummary(
    errors: SchedulerSummary['searches'][number]['errors']
  ): SchedulerSummary['searches'][number] {
    return {
      savedSearchId: 'search-a',
      savedSearchName: 'Search A',
      isPopulationRun: false,
      listingsFoundCount: 0,
      soldSkippedCount: 0,
      aiFilteredOutCount: 0,
      alreadyAlertedCount: 0,
      notifiedCount: 0,
      populatedCount: 0,
      errors,
    };
  }

  it('returns 0 when no search had any errors', () => {
    const summary: SchedulerSummary = { searches: [makeSearchSummary([])] };
    expect(determineExitCode(summary)).toBe(0);
  });

  it('returns 1 when a search has a non-notify error', () => {
    const summary: SchedulerSummary = {
      searches: [makeSearchSummary([{ kind: 'scrape', message: 'Quick search failed' }])],
    };
    expect(determineExitCode(summary)).toBe(1);
  });

  it('returns 1 when only a single search has a notify error — not yet systemic', () => {
    const summary: SchedulerSummary = {
      searches: [makeSearchSummary([{ kind: 'notify', message: 'Notification failed' }])],
    };
    expect(determineExitCode(summary)).toBe(1);
  });

  it('returns 2 when notify errors hit multiple searches in the same tick — likely a systemic outage', () => {
    const summary: SchedulerSummary = {
      searches: [
        {
          ...makeSearchSummary([{ kind: 'notify', message: 'Notification failed' }]),
          savedSearchId: 'search-a',
        },
        {
          ...makeSearchSummary([{ kind: 'notify', message: 'Status notification failed' }]),
          savedSearchId: 'search-b',
        },
      ],
    };
    expect(determineExitCode(summary)).toBe(2);
  });
});
