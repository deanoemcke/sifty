import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing, ProviderCooldownStore, QuickSearchEvent, Recipe } from '../lib/recipes/base';
import { makeListing } from '../lib/testFixtures';

vi.mock('./recipes/registry', () => ({ getRecipeForUrl: vi.fn() }));
vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>();
  return { ...actual, aiJSON: vi.fn(), getAIConfig: vi.fn() };
});

import { aiJSON, getAIConfig } from './ai';
import {
  initSchema,
  stmtClearSearch,
  stmtCountAlertsForSavedSearch,
  stmtInsertSavedSearch,
} from './db';
import { getRecipeForUrl } from './recipes/registry';
import { runSchedulerAsync } from './scheduler';

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
  overrides: { id?: string; name?: string; urls?: string[]; aiFilter?: string | null } = {}
): string {
  const id = overrides.id ?? 'search-1';
  stmtInsertSavedSearch(db).run(
    id,
    overrides.name ?? 'My search',
    JSON.stringify(overrides.urls ?? [SEARCH_URL]),
    null,
    overrides.aiFilter ?? null,
    Date.now(),
    1
  );
  return id;
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
  };
}

beforeEach(() => {
  vi.mocked(getRecipeForUrl).mockReset();
  vi.mocked(aiJSON).mockReset();
  vi.mocked(getAIConfig).mockReset();
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
    // Population runs for both searches, so a later new listing goes through the
    // notify path rather than being silently backfilled.
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
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
});
