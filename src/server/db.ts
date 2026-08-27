// Server-side only — SQLite database singleton, schema init, and all prepared statements.
// DB is initialised lazily on first call to getDb() — no side effects at module scope.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DB_PATH = path.resolve(__dirname, '../../data/sifty.db');

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
      should_alert_on_new_listings INTEGER NOT NULL DEFAULT 0,
      has_completed_population_run INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS trademe_categories (
      slug        TEXT PRIMARY KEY,
      display     TEXT NOT NULL,
      depth       INTEGER NOT NULL,
      parent_slug TEXT,
      legacy_path TEXT NOT NULL,
      embedding   BLOB,
      embedding_model TEXT
    );
    CREATE TABLE IF NOT EXISTS alerted_listings (
      saved_search_id TEXT NOT NULL,
      listing_hash     TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY (saved_search_id, listing_hash)
    );
    CREATE TABLE IF NOT EXISTS sitewide_alert_state (
      cause           TEXT PRIMARY KEY,
      is_active       INTEGER NOT NULL DEFAULT 0,
      last_alerted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ai_filter_verdicts (
      saved_search_id TEXT NOT NULL,
      listing_hash     TEXT NOT NULL,
      prompt_hash      TEXT NOT NULL,
      passed           INTEGER NOT NULL,
      relevance        INTEGER NOT NULL,
      reason           TEXT,
      created_at       INTEGER NOT NULL,
      last_seen_at     INTEGER NOT NULL,
      PRIMARY KEY (saved_search_id, listing_hash)
    );
  `);

  // Superseded by the per-saved-search last_run_succeeded/last_run_detail/
  // last_failure_alerted_at columns below (edge-triggered alerts scoped to
  // one search, instead of a global cross-search reason-text TTL).
  database.exec('DROP TABLE IF EXISTS scrape_error_alerts');

  // CREATE TABLE IF NOT EXISTS doesn't retroactively add columns to an
  // existing on-disk saved_searches table, so new columns need an explicit,
  // idempotency-checked ALTER TABLE (this SQLite build doesn't support
  // ADD COLUMN IF NOT EXISTS).
  const savedSearchColumns = database
    .prepare<[], { name: string }>('PRAGMA table_info(saved_searches)')
    .all();
  if (!savedSearchColumns.some((column) => column.name === 'last_run_at')) {
    database.exec('ALTER TABLE saved_searches ADD COLUMN last_run_at INTEGER');
  }
  if (!savedSearchColumns.some((column) => column.name === 'has_completed_population_run')) {
    database.exec(
      'ALTER TABLE saved_searches ADD COLUMN has_completed_population_run INTEGER NOT NULL DEFAULT 0'
    );
    // Backfill: a pre-migration row that already has alert history has, by
    // definition, already been through (the old, derived version of) a
    // population run — mark it done so existing installs keep notifying
    // normally instead of every history-bearing search silently re-entering
    // population mode (and swallowing its next genuinely new listing) the
    // moment this column defaults everyone to 0.
    database.exec(`
      UPDATE saved_searches
      SET has_completed_population_run = 1
      WHERE id IN (SELECT DISTINCT saved_search_id FROM alerted_listings)
    `);
  }
  if (!savedSearchColumns.some((column) => column.name === 'last_run_succeeded')) {
    database.exec('ALTER TABLE saved_searches ADD COLUMN last_run_succeeded INTEGER');
  }
  if (!savedSearchColumns.some((column) => column.name === 'last_run_detail')) {
    database.exec('ALTER TABLE saved_searches ADD COLUMN last_run_detail TEXT');
  }
  if (!savedSearchColumns.some((column) => column.name === 'last_failure_alerted_at')) {
    database.exec('ALTER TABLE saved_searches ADD COLUMN last_failure_alerted_at INTEGER');
  }
  // Set (synchronously, by stmtMarkAlertSetupNotificationPending) when
  // runImmediatePopulationRunAsync (scheduler.ts) can't acquire the
  // scheduler lock and defers — that deferred call never runs again, so
  // without this flag the eventual real cron tick that later processes the
  // row has no way to know it owes the user an "Alerts set up"/"Couldn't set
  // up alerts" confirmation, and the message is silently dropped forever.
  if (!savedSearchColumns.some((column) => column.name === 'alert_setup_notification_pending')) {
    database.exec(
      'ALTER TABLE saved_searches ADD COLUMN alert_setup_notification_pending INTEGER NOT NULL DEFAULT 0'
    );
  }

  // Same CREATE TABLE IF NOT EXISTS limitation as saved_searches above: an
  // existing on-disk trademe_categories table predating this column won't
  // pick it up from the CREATE TABLE body, so it needs the same explicit,
  // idempotency-checked ALTER TABLE.
  const categoryColumns = database
    .prepare<[], { name: string }>('PRAGMA table_info(trademe_categories)')
    .all();
  if (!categoryColumns.some((column) => column.name === 'embedding')) {
    database.exec('ALTER TABLE trademe_categories ADD COLUMN embedding BLOB');
  }
  if (!categoryColumns.some((column) => column.name === 'embedding_model')) {
    database.exec('ALTER TABLE trademe_categories ADD COLUMN embedding_model TEXT');
  }
  if (categoryColumns.some((column) => column.name === 'top2')) {
    database.exec('ALTER TABLE trademe_categories DROP COLUMN top2');
  }

  // Backs the create/update handlers' duplicate-name rejection with a real DB
  // guarantee — the app-level SELECT-then-INSERT check alone can't stop two
  // concurrent saves both passing the check before either commits. CREATE
  // UNIQUE INDEX fails outright against any pre-existing name collision, so
  // this runs a one-time de-dupe pass first: keep the earliest-created row
  // per name untouched, and rename every later duplicate by appending its id
  // (stable, collision-free) so the index below can always be created.
  const savedSearchIndexes = database
    .prepare<[], { name: string }>('PRAGMA index_list(saved_searches)')
    .all();
  if (!savedSearchIndexes.some((index) => index.name === 'idx_saved_searches_name')) {
    database.exec(`
      UPDATE saved_searches
      SET name = name || ' (' || id || ')'
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at ASC, rowid ASC) AS rn
          FROM saved_searches
        )
        WHERE rn > 1
      )
    `);
    database.exec('CREATE UNIQUE INDEX idx_saved_searches_name ON saved_searches(name)');
  }
}

// better-sqlite3 throws a `Database.SqliteError` (with a `code` string) for
// constraint failures instead of a typed subclass per constraint — this is
// the only way callers can tell "this INSERT/UPDATE lost a uniqueness race"
// apart from any other failure and react to it deliberately instead of
// treating it as a generic 500.
export function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Database.SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE';
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
// throwing SQLITE_BUSY immediately. Both matter once sifty.db is shared (e.g. symlinked)
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
  last_run_at: number | null;
  has_completed_population_run: number;
  last_run_succeeded: number | null;
  last_run_detail: string | null;
  last_failure_alerted_at: number | null;
  alert_setup_notification_pending: number;
};
export type CategoryRow = { slug: string; display: string };
export type CategoryWithEmbeddingRow = {
  slug: string;
  display: string;
  embedding: Buffer | null;
  embedding_model: string | null;
};
export type CategoryEmbeddingCoverageRow = { total: number; embedded: number };
export type CategoryLegacyPathRow = { legacy_path: string };
export type CountRow = { n: number };
export type AlertedListingRow = { saved_search_id: string; listing_hash: string };
export type AiFilterVerdictRow = {
  saved_search_id: string;
  listing_hash: string;
  prompt_hash: string;
  passed: number;
  relevance: number;
  reason: string | null;
};
export type SitewideAlertStateRow = {
  cause: string;
  is_active: number;
  last_alerted_at: number | null;
};

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
export function stmtClearSearchForUrl(database: Database.Database) {
  return database.prepare<[string]>('DELETE FROM quick_searches WHERE url = ?');
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
export function stmtClearDetailsForUrl(database: Database.Database) {
  return database.prepare<[string]>('DELETE FROM deep_details WHERE url = ?');
}
export function stmtListSavedSearches(database: Database.Database) {
  return database.prepare<[], SavedSearchRow>(
    'SELECT id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings, last_run_at, has_completed_population_run, last_run_succeeded, last_run_detail, last_failure_alerted_at, alert_setup_notification_pending FROM saved_searches ORDER BY created_at DESC'
  );
}
export function stmtGetSavedSearch(database: Database.Database) {
  return database.prepare<[string], SavedSearchRow>(
    'SELECT id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings, last_run_at, has_completed_population_run, last_run_succeeded, last_run_detail, last_failure_alerted_at, alert_setup_notification_pending FROM saved_searches WHERE id = ?'
  );
}
export function stmtGetSavedSearchByName(database: Database.Database) {
  return database.prepare<[string], SavedSearchRow>(
    'SELECT id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings, last_run_at, has_completed_population_run, last_run_succeeded, last_run_detail, last_failure_alerted_at, alert_setup_notification_pending FROM saved_searches WHERE name = ?'
  );
}
export function stmtInsertSavedSearch(database: Database.Database) {
  return database.prepare(
    'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
}
// A saved search is "due" when it has never run (NULL last_run_at, which
// sorts before any timestamp in SQLite's ASC ordering) or last ran at or
// before the cutoff; rowid (insertion order) breaks ties between rows with
// equal last_run_at.
const DUE_ALERT_ENABLED_SAVED_SEARCH_WHERE =
  'WHERE should_alert_on_new_listings = 1 AND (last_run_at IS NULL OR last_run_at <= ?)';

export function stmtGetDueAlertEnabledSavedSearches(database: Database.Database) {
  return database.prepare<[number, number], SavedSearchRow>(
    'SELECT id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings, last_run_at, has_completed_population_run, last_run_succeeded, last_run_detail, last_failure_alerted_at, alert_setup_notification_pending ' +
      `FROM saved_searches ${DUE_ALERT_ENABLED_SAVED_SEARCH_WHERE} ` +
      'ORDER BY last_run_at ASC, rowid ASC LIMIT ?'
  );
}

export function stmtCountDueAlertEnabledSavedSearches(database: Database.Database) {
  return database.prepare<[number], { count: number }>(
    `SELECT COUNT(*) AS count FROM saved_searches ${DUE_ALERT_ENABLED_SAVED_SEARCH_WHERE}`
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
export function stmtUpdateSavedSearch(database: Database.Database) {
  return database.prepare(
    'UPDATE saved_searches SET name = ?, urls = ?, discover_inputs = ?, ai_filter = ? WHERE id = ?'
  );
}
export function stmtUpdateSavedSearchLastRunAt(database: Database.Database) {
  return database.prepare('UPDATE saved_searches SET last_run_at = ? WHERE id = ?');
}
export function stmtMarkPopulationRunComplete(database: Database.Database) {
  return database.prepare(
    'UPDATE saved_searches SET has_completed_population_run = 1 WHERE id = ?'
  );
}
// Synchronous counterpart to stmtMarkPopulationRunComplete, called the moment
// alerts are (re-)enabled or an already alert-on search's urls/aiFilter
// change (see routes/savedSearches.ts). Without this, a search that already
// completed one population run keeps has_completed_population_run = 1 in the
// DB until the fire-and-forget immediate population run (scheduler.ts)
// finishes — if that background job is deferred (scheduler lock held by a
// real cron tick) or just hasn't finished yet, a real tick can read the
// stale flag first, wrongly treat the never-actually-rebaselined
// configuration as fully baselined, and notify on every currently matching
// listing at once.
export function stmtResetSavedSearchPopulationRun(database: Database.Database) {
  return database.prepare(
    'UPDATE saved_searches SET has_completed_population_run = 0 WHERE id = ?'
  );
}
// Set when runImmediatePopulationRunAsync (scheduler.ts) can't acquire the
// scheduler lock and defers, carrying the "this row owes the user a setup
// confirmation" intent forward to whichever future run — deferred retry or
// ordinary cron tick — actually processes this saved search next, since
// isImmediateSetupRun itself is only ever set on the one call that deferred.
export function stmtMarkAlertSetupNotificationPending(database: Database.Database) {
  return database.prepare(
    'UPDATE saved_searches SET alert_setup_notification_pending = 1 WHERE id = ?'
  );
}
// Counterpart to stmtMarkAlertSetupNotificationPending — called by
// recordSavedSearchRunStatusAndAlertAsync (scheduler.ts) the moment a pending
// flag is read and folded into that run's setup-confirmation decision, so a
// later run doesn't see the same flag still set and resend the confirmation
// a second time.
export function stmtClearAlertSetupNotificationPending(database: Database.Database) {
  return database.prepare(
    'UPDATE saved_searches SET alert_setup_notification_pending = 0 WHERE id = ?'
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
// Caches a listing's AI-filter verdict per saved search so an unchanged
// listing (same computeAlertFingerprint hash) isn't re-sent to the LLM on
// every scheduler tick — see processSavedSearchAsync (scheduler.ts), which
// only calls runAiFilterBatchesAsync for listings this lookup misses.
export function stmtGetAiFilterVerdict(database: Database.Database) {
  return database.prepare<[string, string], AiFilterVerdictRow>(
    'SELECT saved_search_id, listing_hash, prompt_hash, passed, relevance, reason FROM ai_filter_verdicts WHERE saved_search_id = ? AND listing_hash = ?'
  );
}
// prompt_hash is overwritten (not appended) on conflict so there is exactly
// one current verdict per (saved_search_id, listing_hash) — an edited
// ai_filter prompt, or an upgraded/switched AI model or provider (both fold
// into the hash callers store here — see processSavedSearchAsync's
// verdictCacheKey in scheduler.ts), naturally invalidates the previous
// verdict next time it's read, without needing a separate cache-clear at the
// prompt-edit (or model-change) call site.
export function stmtUpsertAiFilterVerdict(database: Database.Database) {
  return database.prepare(
    'INSERT INTO ai_filter_verdicts (saved_search_id, listing_hash, prompt_hash, passed, relevance, reason, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(saved_search_id, listing_hash) DO UPDATE SET ' +
      'prompt_hash = excluded.prompt_hash, passed = excluded.passed, relevance = excluded.relevance, reason = excluded.reason, created_at = excluded.created_at, last_seen_at = excluded.last_seen_at'
  );
}
// Bumped on every cache hit (not just on a fresh AI call) so expiry tracks
// "not seen in any scrape for N days," not "first scored N days ago" — a
// still-active listing that keeps hitting the cache must never age out.
export function stmtTouchAiFilterVerdict(database: Database.Database) {
  return database.prepare<[number, string, string]>(
    'UPDATE ai_filter_verdicts SET last_seen_at = ? WHERE saved_search_id = ? AND listing_hash = ?'
  );
}
export function stmtPruneStaleAiFilterVerdicts(database: Database.Database) {
  return database.prepare<[number]>('DELETE FROM ai_filter_verdicts WHERE last_seen_at < ?');
}
// Persists the outcome of a saved search's most recent scheduled run —
// last_failure_alerted_at only changes when a failure alert is actually sent
// (not on every failed run), so it's the clock recordSavedSearchRunStatusAndAlertAsync
// (scheduler.ts) measures its re-alert window against.
export function stmtUpdateSavedSearchRunStatus(database: Database.Database) {
  return database.prepare(
    'UPDATE saved_searches SET last_run_succeeded = ?, last_run_detail = ?, last_failure_alerted_at = ? WHERE id = ?'
  );
}
// Tracks whether a single application-wide failure cause (e.g. the shared
// Facebook-cookies login requirement) is currently active, independent of
// any one saved search — see reconcileSitewideAlertAsync in scheduler.ts,
// which uses this row as the coordination point that lets N
// affected saved searches collapse into exactly one failure/recovery alert.
export function stmtGetSitewideAlertState(database: Database.Database) {
  return database.prepare<[string], SitewideAlertStateRow>(
    'SELECT cause, is_active, last_alerted_at FROM sitewide_alert_state WHERE cause = ?'
  );
}
export function stmtUpsertSitewideAlertState(database: Database.Database) {
  return database.prepare(
    'INSERT INTO sitewide_alert_state (cause, is_active, last_alerted_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(cause) DO UPDATE SET is_active = excluded.is_active, last_alerted_at = excluded.last_alerted_at'
  );
}
export function stmtGetAllCategoriesWithEmbeddings(database: Database.Database) {
  return database.prepare<[], CategoryWithEmbeddingRow>(
    'SELECT slug, display, embedding, embedding_model FROM trademe_categories'
  );
}
export function stmtGetCategoryEmbeddingCoverage(database: Database.Database) {
  return database.prepare<[string], CategoryEmbeddingCoverageRow>(
    'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN embedding IS NOT NULL AND embedding_model = ? THEN 1 ELSE 0 END), 0) AS embedded FROM trademe_categories'
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
