// Server-side only — SQLite database singleton, schema init, and all prepared statements.
// DB is initialised lazily on first call to getDb() — no side effects at module scope.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.resolve(__dirname, "../../.cache/cache.db");

let _db: Database.Database | null = null;

export function initSchema(database: Database.Database): void {
  database.exec(`
    DROP TABLE IF EXISTS schema_version;
    DROP TABLE IF EXISTS saved_searches;
    DROP TABLE IF EXISTS quick_searches;
    DROP TABLE IF EXISTS deep_details;
    DROP TABLE IF EXISTS trademe_categories;

    CREATE TABLE quick_searches (
      url           TEXT PRIMARY KEY,
      data          TEXT NOT NULL,
      cached_at     INTEGER NOT NULL,
      listing_count INTEGER
    );
    CREATE TABLE deep_details (
      url       TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      cached_at INTEGER NOT NULL
    );
    CREATE TABLE saved_searches (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      urls            TEXT NOT NULL,
      discover_inputs TEXT,
      ai_filter       TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE trademe_categories (
      slug        TEXT PRIMARY KEY,
      display     TEXT NOT NULL,
      depth       INTEGER NOT NULL,
      parent_slug TEXT,
      top2        TEXT NOT NULL
    );
  `);
}

function logDbStats(database: Database.Database): void {
  const totalCategoriesCount = database
    .prepare<[], { n: number }>("SELECT COUNT(*) as n FROM trademe_categories")
    .get()?.n;
  if (totalCategoriesCount === 0)
    console.warn(
      "[categories] trademe_categories table is empty — run: npx ts-node scripts/import-categories.ts",
    );
  else console.log(`[categories] ${totalCategoriesCount} TradeMe categories loaded`);

  const searchCount = database
    .prepare<[], { n: number }>("SELECT COUNT(*) as n FROM quick_searches")
    .get()?.n ?? 0;
  const detailCount = database
    .prepare<[], { n: number }>("SELECT COUNT(*) as n FROM deep_details")
    .get()?.n ?? 0;
  if (searchCount > 0 || detailCount > 0)
    console.log(`[cache] opened db — ${searchCount} searches, ${detailCount} listing details`);
}

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  initSchema(_db);
  logDbStats(_db);
  return _db;
}

// ── Prepared statement types ──────────────────────────────────────────────────

export type SearchRow = { data: string; cached_at: number };
export type DetailRow = { data: string; cached_at: number };
export type SavedSearchRow = {
  id: string;
  name: string;
  urls: string;
  discover_inputs: string | null;
  ai_filter: string | null;
  created_at: number;
};
export type CategoryRow = { slug: string; display: string };
export type CountRow = { n: number };

// ── Statement accessors ───────────────────────────────────────────────────────
// Each function prepares the statement fresh against the live db instance.
// Using per-call prepare() is fine for these low-frequency admin routes;
// for hot-path routes callers should cache the result if needed.

export function stmtGetSearch(database: Database.Database) {
  return database.prepare<[string], SearchRow>(
    "SELECT data, cached_at FROM quick_searches WHERE url = ?",
  );
}
export function stmtSetSearch(database: Database.Database) {
  return database.prepare(
    "INSERT OR REPLACE INTO quick_searches (url, data, cached_at, listing_count) VALUES (?, ?, ?, ?)",
  );
}
export function stmtClearSearch(database: Database.Database) {
  return database.prepare("DELETE FROM quick_searches");
}
export function stmtGetDetail(database: Database.Database) {
  return database.prepare<[string], DetailRow>(
    "SELECT data, cached_at FROM deep_details WHERE url = ?",
  );
}
export function stmtSetDetail(database: Database.Database) {
  return database.prepare(
    "INSERT OR REPLACE INTO deep_details (url, data, cached_at) VALUES (?, ?, ?)",
  );
}
export function stmtClearDetails(database: Database.Database) {
  return database.prepare("DELETE FROM deep_details");
}
export function stmtCountSearch(database: Database.Database) {
  return database.prepare<[], CountRow>("SELECT COUNT(*) as n FROM quick_searches");
}
export function stmtCountDetails(database: Database.Database) {
  return database.prepare<[], CountRow>("SELECT COUNT(*) as n FROM deep_details");
}
export function stmtListSavedSearches(database: Database.Database) {
  return database.prepare<[], SavedSearchRow>(
    "SELECT id, name, urls, discover_inputs, ai_filter, created_at FROM saved_searches ORDER BY created_at DESC",
  );
}
export function stmtGetSavedSearch(database: Database.Database) {
  return database.prepare<[string], SavedSearchRow>(
    "SELECT id, name, urls, discover_inputs, ai_filter, created_at FROM saved_searches WHERE id = ?",
  );
}
export function stmtInsertSavedSearch(database: Database.Database) {
  return database.prepare(
    "INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
}
export function stmtDeleteSavedSearch(database: Database.Database) {
  return database.prepare("DELETE FROM saved_searches WHERE id = ?");
}
export function stmtGetCategoriesAtDepth2(database: Database.Database) {
  return database.prepare<[], CategoryRow>(
    "SELECT slug, display FROM trademe_categories WHERE depth = 2 ORDER BY slug",
  );
}
export function stmtGetCategoriesByTop2(database: Database.Database) {
  return database.prepare<[string], CategoryRow>(
    "SELECT slug, display FROM trademe_categories WHERE top2 = ? ORDER BY depth, slug",
  );
}

// ── Cache freshness helpers ───────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000;

export function isFresh(cachedAt: number): boolean {
  return Date.now() - cachedAt < CACHE_TTL_MS;
}

export function cacheAge(cachedAt: number): string {
  const mins = Math.floor((Date.now() - cachedAt) / 60000);
  return mins === 0 ? "less than a minute ago" : `${mins} minute${mins !== 1 ? "s" : ""} ago`;
}
