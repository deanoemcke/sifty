// Regression coverage for a specific fragility: scheduler.ts's Facebook
// cookie-health tracking (see the `facebookCookieHealthChecked` comment in
// scheduler.ts) must compare against the canonical `facebookRecipe.name`
// export from recipes/facebook.ts, not a bare 'facebook' string literal. If
// RECIPE_PATTERNS' facebook entry (src/lib/recipes/metadata.ts) is ever
// renamed, `facebookRecipe.name` changes with it — a hardcoded literal
// comparison would silently and permanently stop matching, freezing the
// sitewide Facebook-cookies alert in whatever state it was last in with no
// compiler or test signal.
//
// This file mocks recipes/facebook's `facebookRecipe` export to simulate
// exactly that rename (isolated to this file so it can't affect the main
// scheduler.test.ts suite), then runs the same fail-then-recover scenario
// scheduler.test.ts already covers for the real name. Against a
// `recipe.name === 'facebook'` literal comparison, the renamed recipe would
// never be recognized as Facebook, `facebookCookieHealthChecked` would never
// be set, and the sitewide alert would never recover — this test fails on
// that implementation and passes once the comparison is anchored to
// `facebookRecipe.name`.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing, ProviderCooldownStore, QuickSearchEvent, Recipe } from '../lib/recipes/base';
import { makeListing } from '../lib/testFixtures';

// vi.mock factories are hoisted above top-level const declarations, so the
// shared name must be defined via vi.hoisted to be visible inside the factory.
const { RENAMED_FACEBOOK_RECIPE_NAME } = vi.hoisted(() => ({
  RENAMED_FACEBOOK_RECIPE_NAME: 'facebook-renamed-for-test',
}));

vi.mock('./recipes/registry', () => ({ getRecipeForUrl: vi.fn() }));
vi.mock('./connectivity', () => ({
  checkInternetConnectivityAsync: vi.fn().mockResolvedValue(true),
}));
vi.mock('./recipes/facebook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recipes/facebook')>();
  return {
    ...actual,
    facebookRecipe: { ...actual.facebookRecipe, name: RENAMED_FACEBOOK_RECIPE_NAME },
  };
});

import { checkInternetConnectivityAsync } from './connectivity';
import {
  initSchema,
  stmtClearSearch,
  stmtGetSitewideAlertState,
  stmtInsertSavedSearch,
} from './db';
import { LOGIN_REQUIRED_MESSAGE } from './recipes/facebook';
import { getRecipeForUrl } from './recipes/registry';
import {
  FACEBOOK_COOKIES_CAUSE,
  runSchedulerAsync as runSchedulerAsyncUngated,
  type SchedulerDeps,
} from './scheduler';
import { formatFacebookCookiesRecoveredMessage } from './signalMessage';

const STUB_COOLDOWN_STORE: ProviderCooldownStore = {
  markExhausted: () => {},
  getCooldownUntil: () => undefined,
};

function runSchedulerAsync(deps: SchedulerDeps) {
  return runSchedulerAsyncUngated({ targetIntervalMs: 0, ...deps });
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function insertAlertSearch(db: Database.Database, name: string, urls: string[]): string {
  const id = 'search-1';
  stmtInsertSavedSearch(db).run(id, name, JSON.stringify(urls), null, null, Date.now(), 1);
  return id;
}

function stubComputeAlertFingerprint(listing: Listing): string {
  return listing.url ?? listing.title ?? '';
}

// Recipe whose `name` is the *renamed* canonical Facebook identifier, mirroring
// the mocked `facebookRecipe.name` above rather than the literal 'facebook'.
function makeRenamedStubRecipe(listings: Listing[]): Recipe {
  return {
    name: RENAMED_FACEBOOK_RECIPE_NAME,
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

function makeRenamedFacebookCookieFailureRecipe(): Recipe {
  return {
    name: RENAMED_FACEBOOK_RECIPE_NAME,
    matches: () => true,
    extractImplicitFilters: () => [],
    quickSearchAsync: async (_url: string, onEvent: (event: QuickSearchEvent) => void) => {
      onEvent({ type: 'error', message: LOGIN_REQUIRED_MESSAGE });
    },
    deepSearchAsync: async () => {},
    computeAlertFingerprint: stubComputeAlertFingerprint,
  };
}

beforeEach(() => {
  vi.mocked(getRecipeForUrl).mockReset();
  vi.mocked(checkInternetConnectivityAsync).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sitewide Facebook-cookies recovery survives a canonical recipe rename', () => {
  it('still recovers the sitewide alert when the Facebook recipe has been renamed', async () => {
    const db = freshDb();
    insertAlertSearch(db, 'FB search', ['https://facebook.com/marketplace/search']);
    const seedListing = makeListing({ title: 'Existing', url: 'https://example.com/existing' });

    // Baseline population run under the renamed recipe.
    vi.mocked(getRecipeForUrl).mockReturnValue(makeRenamedStubRecipe([seedListing]));
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    stmtClearSearch(db).run();

    // A cookie failure under the renamed recipe activates the sitewide alert.
    vi.mocked(getRecipeForUrl).mockReturnValue(makeRenamedFacebookCookieFailureRecipe());
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync: vi.fn(),
    });
    expect(stmtGetSitewideAlertState(db).get(FACEBOOK_COOKIES_CAUSE)?.is_active).toBe(1);
    stmtClearSearch(db).run();

    // A subsequent successful run under the renamed recipe must still be
    // recognized as Facebook cookie-health evidence and recover the alert.
    vi.mocked(getRecipeForUrl).mockReturnValue(makeRenamedStubRecipe([seedListing]));
    const sendNotificationAsync = vi.fn().mockResolvedValue(undefined);
    await runSchedulerAsync({
      database: db,
      cooldownStore: STUB_COOLDOWN_STORE,
      sendNotificationAsync,
    });

    expect(sendNotificationAsync.mock.calls.map((call) => call[0])).toContain(
      formatFacebookCookiesRecoveredMessage()
    );
    expect(stmtGetSitewideAlertState(db).get(FACEBOOK_COOKIES_CAUSE)?.is_active).toBe(0);
  });
});
