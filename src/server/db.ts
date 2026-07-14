// Server-side only — SQLite database singleton, schema init, and all prepared statements.
// DB is initialised lazily on first call to getDb() — no side effects at module scope.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve(__dirname, '../../.cache/cache.db');

let _db: Database.Database | null = null;

export function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS quick_searches (
      url           TEXT PRIMARY KEY,
      data          TEXT NOT NULL,
      cached_at     INTEGER NOT NULL,
      listing_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS deep_details (
      url       TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      cached_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_searches (
      id                          TEXT PRIMARY KEY,
      name                        TEXT NOT NULL,
      urls                        TEXT NOT NULL,
      discover_inputs             TEXT,
      ai_filter                   TEXT,
      created_at                  INTEGER NOT NULL,
      should_alert_on_new_listings INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS trademe_categories (
      slug        TEXT PRIMARY KEY,
      display     TEXT NOT NULL,
      depth       INTEGER NOT NULL,
      parent_slug TEXT,
      top2        TEXT NOT NULL,
      legacy_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerted_listings (
      saved_search_id TEXT NOT NULL,
      listing_hash     TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY (saved_search_id, listing_hash)
    );
  `);
}

function logDbStats(database: Database.Database): void {
  const totalCategoriesCount = database
    .prepare<[], { n: number }>('SELECT COUNT(*) as n FROM trademe_categories')
    .get()?.n;
  if (totalCategoriesCount === 0)
    console.warn(
      '[categories] trademe_categories table is empty — run: npx ts-node scripts/import-categories.ts'
    );
  else console.log(`[categories] ${totalCategoriesCount} TradeMe categories loaded`);

  const searchCount =
    database.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM quick_searches').get()?.n ?? 0;
  const detailCount =
    database.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM deep_details').get()?.n ?? 0;
  if (searchCount > 0 || detailCount > 0)
    console.log(`[cache] opened db — ${searchCount} searches, ${detailCount} listing details`);
}

// WAL mode lets one writer and multiple readers access the file concurrently instead of
// exclusive-locking it; the busy timeout makes a writer retry for a while instead of
// throwing SQLITE_BUSY immediately. Both matter once cache.db is shared (e.g. symlinked)
// across worktrees whose dev servers run as separate processes at the same time.
export function configureDatabaseConnection(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
}

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  configureDatabaseConnection(_db);
  initSchema(_db);
  logDbStats(_db);
  return _db;
}

// ── Prepared statement types ──────────────────────────────────────────────────

export type SearchRow = { data: string; cached_at: number; listing_count: number };
export type DetailRow = { data: string; cached_at: number };
export type SavedSearchRow = {
  id: string;
  name: string;
  urls: string;
  discover_inputs: string | null;
  ai_filter: string | null;
  created_at: number;
  should_alert_on_new_listings: number;
};
export type CategoryRow = { slug: string; display: string };
export type CategoryLegacyPathRow = { legacy_path: string };
export type CountRow = { n: number };
export type AlertedListingRow = { saved_search_id: string; listing_hash: string };

// ── Statement accessors ───────────────────────────────────────────────────────
// Each function prepares the statement fresh against the live db instance.
// Using per-call prepare() is fine for these low-frequency admin routes;
// for hot-path routes callers should cache the result if needed.

export function stmtGetSearch(database: Database.Database) {
  return database.prepare<[string], SearchRow>(
    'SELECT data, cached_at, listing_count FROM quick_searches WHERE url = ?'
  );
}
export function stmtSetSearch(database: Database.Database) {
  return database.prepare(
    'INSERT OR REPLACE INTO quick_searches (url, data, cached_at, listing_count) VALUES (?, ?, ?, ?)'
  );
}
export function stmtClearSearch(database: Database.Database) {
  return database.prepare('DELETE FROM quick_searches');
}
export function stmtGetDetail(database: Database.Database) {
  return database.prepare<[string], DetailRow>(
    'SELECT data, cached_at FROM deep_details WHERE url = ?'
  );
}
export function stmtSetDetail(database: Database.Database) {
  return database.prepare(
    'INSERT OR REPLACE INTO deep_details (url, data, cached_at) VALUES (?, ?, ?)'
  );
}
export function stmtClearDetails(database: Database.Database) {
  return database.prepare('DELETE FROM deep_details');
}
export function stmtCountSearch(database: Database.Database) {
  return database.prepare<[], CountRow>('SELECT COUNT(*) as n FROM quick_searches');
}
export function stmtCountDetails(database: Database.Database) {
  return database.prepare<[], CountRow>('SELECT COUNT(*) as n FROM deep_details');
}
export function stmtListSavedSearches(database: Database.Database) {
  return database.prepare<[], SavedSearchRow>(
    'SELECT id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings FROM saved_searches ORDER BY created_at DESC'
  );
}
export function stmtGetSavedSearch(database: Database.Database) {
  return database.prepare<[string], SavedSearchRow>(
    'SELECT id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings FROM saved_searches WHERE id = ?'
  );
}
export function stmtInsertSavedSearch(database: Database.Database) {
  return database.prepare(
    'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
}
export function stmtDeleteSavedSearch(database: Database.Database) {
  return database.prepare('DELETE FROM saved_searches WHERE id = ?');
}
export function stmtUpdateSavedSearchAlert(database: Database.Database) {
  return database.prepare(
    'UPDATE saved_searches SET should_alert_on_new_listings = ? WHERE id = ?'
  );
}
export function stmtCountAlertsForSavedSearch(database: Database.Database) {
  return database.prepare<[string], CountRow>(
    'SELECT COUNT(*) as n FROM alerted_listings WHERE saved_search_id = ?'
  );
}
export function stmtHasAlertedListing(database: Database.Database) {
  return database.prepare<[string, string], AlertedListingRow>(
    'SELECT saved_search_id, listing_hash FROM alerted_listings WHERE saved_search_id = ? AND listing_hash = ?'
  );
}
export function stmtInsertAlertedListing(database: Database.Database) {
  return database.prepare(
    'INSERT OR IGNORE INTO alerted_listings (saved_search_id, listing_hash, created_at) VALUES (?, ?, ?)'
  );
}
export function stmtGetCategoriesAtDepth2(database: Database.Database) {
  return database.prepare<[], CategoryRow>(
    'SELECT slug, display FROM trademe_categories WHERE depth = 2 ORDER BY slug'
  );
}
export function stmtGetCategoriesByTop2(database: Database.Database) {
  return database.prepare<[string], CategoryRow>(
    'SELECT slug, display FROM trademe_categories WHERE top2 = ? ORDER BY depth, slug'
  );
}
export function stmtGetCategoryLegacyPath(database: Database.Database) {
  return database.prepare<[string], CategoryLegacyPathRow>(
    'SELECT legacy_path FROM trademe_categories WHERE slug = ?'
  );
}
export function stmtGetCategoryByLegacyPath(database: Database.Database) {
  return database.prepare<[string], CategoryRow>(
    'SELECT slug, display FROM trademe_categories WHERE legacy_path = ?'
  );
}

// ── Cache freshness helpers ───────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000;

// A genuine zero-result search (see `classifyInitialSearchStateAsync` in
// facebook.ts) is a legitimate success and gets cached like any other result —
// but the empty-state classifier is a heuristic, and a misclassified soft-block
// would otherwise get pinned as a false "genuinely empty" answer for the whole
// cache window. A shorter TTL bounds how long a wrong classification can
// persist, while still absorbing same-search repeats (e.g. a sold-items
// discover firing the same URL twice, or a user re-running a niche search)
// without relaunching a full authenticated browser session each time.
export const EMPTY_RESULT_CACHE_TTL_MS = CACHE_TTL_MS / 6; // 10 minutes

// Single source of truth for which TTL applies to a cache row — read side
// (isFresh check) and write side (deciding whether a row counts as "empty")
// both derive from the same listing count rather than tracking freshness two
// different ways.
export function ttlForListingCount(listingCount: number): number {
  return listingCount > 0 ? CACHE_TTL_MS : EMPTY_RESULT_CACHE_TTL_MS;
}

export function isFresh(cachedAt: number, ttlMs: number = CACHE_TTL_MS): boolean {
  return Date.now() - cachedAt < ttlMs;
}

export function cacheAge(cachedAt: number): string {
  const mins = Math.floor((Date.now() - cachedAt) / 60000);
  return mins === 0 ? 'less than a minute ago' : `${mins} minute${mins !== 1 ? 's' : ''} ago`;
}
