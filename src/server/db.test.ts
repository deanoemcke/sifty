import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureDatabaseConnection,
  initSchema,
  isUniqueConstraintViolation,
  stmtClearDetailsForUrl,
  stmtClearSearchForUrl,
  stmtCountAlertsForSavedSearch,
  stmtGetDetail,
  stmtGetOldestAlertEnabledSavedSearch,
  stmtGetSavedSearchByName,
  stmtGetSearch,
  stmtHasAlertedListing,
  stmtInsertAlertedListing,
  stmtInsertSavedSearch,
  stmtSetDetail,
  stmtSetSearch,
  stmtUpdateSavedSearch,
  stmtUpdateSavedSearchLastRunAt,
} from './db';

function columnNames(db: Database.Database, table: string): string[] {
  return db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return db
    .prepare<[], { name: string }>(`PRAGMA index_list(${table})`)
    .all()
    .map((r) => r.name);
}

describe('initSchema', () => {
  it('creates all tables on a fresh database', () => {
    const db = new Database(':memory:');
    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, 'quick_searches')).toContain('url');
    expect(columnNames(db, 'deep_details')).toContain('url');
    expect(columnNames(db, 'saved_searches')).toContain('id');
    expect(columnNames(db, 'trademe_categories')).toContain('slug');
    expect(columnNames(db, 'alerted_listings')).toContain('listing_hash');
  });

  it('saved_searches has discover_inputs column, not filters', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const cols = columnNames(db, 'saved_searches');
    expect(cols).toContain('discover_inputs');
    expect(cols).not.toContain('filters');
  });

  it('quick_searches does not have is_complete column', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(columnNames(db, 'quick_searches')).not.toContain('is_complete');
  });

  it('is idempotent — calling twice does not throw', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, 'saved_searches')).toContain('discover_inputs');
  });

  it('saved_searches has a last_run_at column, added idempotently', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(columnNames(db, 'saved_searches')).toContain('last_run_at');
    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, 'saved_searches')).toContain('last_run_at');
  });

  it('saved_searches has a has_completed_population_run column, added idempotently', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(columnNames(db, 'saved_searches')).toContain('has_completed_population_run');
    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, 'saved_searches')).toContain('has_completed_population_run');
  });

  it('backfills has_completed_population_run = 1 for existing rows with alert history, and 0 for rows without, when migrating an existing on-disk database', () => {
    // Simulates a pre-migration on-disk schema — no has_completed_population_run column yet.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE saved_searches (
        id                          TEXT PRIMARY KEY,
        name                        TEXT NOT NULL,
        urls                        TEXT NOT NULL,
        discover_inputs             TEXT,
        ai_filter                   TEXT,
        created_at                  INTEGER NOT NULL,
        should_alert_on_new_listings INTEGER NOT NULL DEFAULT 0,
        last_run_at                 INTEGER
      );
      CREATE TABLE alerted_listings (
        saved_search_id TEXT NOT NULL,
        listing_hash     TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        PRIMARY KEY (saved_search_id, listing_hash)
      );
    `);
    db.prepare(
      'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('has-history', 'Has history', '[]', null, null, 1000, 1);
    db.prepare(
      'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('no-history', 'No history', '[]', null, null, 1000, 1);
    db.prepare(
      'INSERT INTO alerted_listings (saved_search_id, listing_hash, created_at) VALUES (?, ?, ?)'
    ).run('has-history', 'hash-a', 1000);

    initSchema(db);

    const rows = db
      .prepare<[], { id: string; has_completed_population_run: number }>(
        'SELECT id, has_completed_population_run FROM saved_searches ORDER BY id'
      )
      .all();
    expect(rows.find((r) => r.id === 'has-history')?.has_completed_population_run).toBe(1);
    expect(rows.find((r) => r.id === 'no-history')?.has_completed_population_run).toBe(0);
  });

  it('saved_searches.name has a UNIQUE index, added idempotently', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(indexNames(db, 'saved_searches')).toContain('idx_saved_searches_name');

    stmtInsertSavedSearch(db).run('s1', 'Vintage lamps', '[]', null, null, 1000, 0);
    expect(() =>
      stmtInsertSavedSearch(db).run('s2', 'Vintage lamps', '[]', null, null, 2000, 0)
    ).toThrow(/UNIQUE constraint failed/);

    expect(() => initSchema(db)).not.toThrow();
    expect(indexNames(db, 'saved_searches')).toContain('idx_saved_searches_name');
  });

  it('de-dupes existing colliding names before creating the unique index, when migrating an existing on-disk database', () => {
    // Simulates a pre-migration on-disk schema — no unique index on name yet,
    // and two rows that already collide.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE saved_searches (
        id                           TEXT PRIMARY KEY,
        name                         TEXT NOT NULL,
        urls                         TEXT NOT NULL,
        discover_inputs              TEXT,
        ai_filter                    TEXT,
        created_at                   INTEGER NOT NULL,
        should_alert_on_new_listings INTEGER NOT NULL DEFAULT 0,
        last_run_at                  INTEGER,
        has_completed_population_run INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('older', 'Duplicate name', '[]', null, null, 1000, 0);
    db.prepare(
      'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('newer', 'Duplicate name', '[]', null, null, 2000, 0);

    expect(() => initSchema(db)).not.toThrow();
    expect(indexNames(db, 'saved_searches')).toContain('idx_saved_searches_name');

    const rows = db
      .prepare<[], { id: string; name: string }>('SELECT id, name FROM saved_searches ORDER BY id')
      .all();
    // Earliest-created row keeps its original name; the later duplicate is renamed.
    expect(rows.find((r) => r.id === 'older')?.name).toBe('Duplicate name');
    expect(rows.find((r) => r.id === 'newer')?.name).toBe('Duplicate name (newer)');
  });

  it('trademe_categories has an embedding column, added idempotently, when migrating an existing on-disk database', () => {
    // Simulates a pre-migration on-disk schema — no embedding column yet.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE trademe_categories (
        slug        TEXT PRIMARY KEY,
        display     TEXT NOT NULL,
        depth       INTEGER NOT NULL,
        parent_slug TEXT,
        top2        TEXT NOT NULL,
        legacy_path TEXT NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO trademe_categories (slug, display, depth, parent_slug, top2, legacy_path) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('electronics', 'Electronics', 1, null, 'electronics', '0124-');

    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, 'trademe_categories')).toContain('embedding');

    const row = db
      .prepare<[string], { slug: string; embedding: string | null }>(
        'SELECT slug, embedding FROM trademe_categories WHERE slug = ?'
      )
      .get('electronics');
    expect(row?.embedding).toBeNull();

    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, 'trademe_categories')).toContain('embedding');
  });

  it('trademe_categories has an embedding_model column, added idempotently, when migrating an existing on-disk database', () => {
    // Simulates a pre-migration on-disk schema — embedding column exists, embedding_model doesn't.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE trademe_categories (
        slug        TEXT PRIMARY KEY,
        display     TEXT NOT NULL,
        depth       INTEGER NOT NULL,
        parent_slug TEXT,
        top2        TEXT NOT NULL,
        legacy_path TEXT NOT NULL,
        embedding   TEXT
      );
    `);
    db.prepare(
      'INSERT INTO trademe_categories (slug, display, depth, parent_slug, top2, legacy_path, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('electronics', 'Electronics', 1, null, 'electronics', '0124-', '[0.1,0.2]');

    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, 'trademe_categories')).toContain('embedding_model');

    const row = db
      .prepare<[string], { slug: string; embedding_model: string | null }>(
        'SELECT slug, embedding_model FROM trademe_categories WHERE slug = ?'
      )
      .get('electronics');
    expect(row?.embedding_model).toBeNull();

    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, 'trademe_categories')).toContain('embedding_model');
  });

  it('preserves existing data when called on an existing database', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare(
      'INSERT INTO trademe_categories (slug, display, depth, parent_slug, top2, legacy_path) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('electronics', 'Electronics', 1, null, 'electronics', '0124-');
    initSchema(db);
    const count = db
      .prepare<[], { n: number }>('SELECT COUNT(*) as n FROM trademe_categories')
      .get()?.n;
    expect(count).toBe(1);
  });
});

describe('alerted_listings statements', () => {
  function freshDb(): Database.Database {
    const db = new Database(':memory:');
    initSchema(db);
    return db;
  }

  it('counts zero alerts for a saved search with no rows', () => {
    const db = freshDb();
    expect(stmtCountAlertsForSavedSearch(db).get('search-1')?.n).toBe(0);
  });

  it('counts only rows for the given saved search id', () => {
    const db = freshDb();
    stmtInsertAlertedListing(db).run('search-1', 'hash-a', 1000);
    stmtInsertAlertedListing(db).run('search-2', 'hash-b', 1000);
    expect(stmtCountAlertsForSavedSearch(db).get('search-1')?.n).toBe(1);
  });

  it('reports no existing alert for an unseen (saved search, hash) pair', () => {
    const db = freshDb();
    expect(stmtHasAlertedListing(db).get('search-1', 'hash-a')).toBeUndefined();
  });

  it('reports an existing alert after insertion', () => {
    const db = freshDb();
    stmtInsertAlertedListing(db).run('search-1', 'hash-a', 1000);
    expect(stmtHasAlertedListing(db).get('search-1', 'hash-a')).toBeDefined();
  });

  it('the same hash is independent across two different saved searches', () => {
    const db = freshDb();
    stmtInsertAlertedListing(db).run('search-1', 'hash-a', 1000);
    expect(stmtHasAlertedListing(db).get('search-2', 'hash-a')).toBeUndefined();
  });

  it('inserting the same (saved search, hash) pair twice does not throw or duplicate', () => {
    const db = freshDb();
    expect(() => {
      stmtInsertAlertedListing(db).run('search-1', 'hash-a', 1000);
      stmtInsertAlertedListing(db).run('search-1', 'hash-a', 2000);
    }).not.toThrow();
    expect(stmtCountAlertsForSavedSearch(db).get('search-1')?.n).toBe(1);
  });
});

describe('scoped cache-clear statements', () => {
  function freshDb(): Database.Database {
    const db = new Database(':memory:');
    initSchema(db);
    return db;
  }

  it('stmtClearSearchForUrl deletes only the matching quick_searches row', () => {
    const db = freshDb();
    stmtSetSearch(db).run('https://example.com/a', '[]', 1000, 0);
    stmtSetSearch(db).run('https://example.com/b', '[]', 1000, 0);

    stmtClearSearchForUrl(db).run('https://example.com/a');

    expect(stmtGetSearch(db).get('https://example.com/a')).toBeUndefined();
    expect(stmtGetSearch(db).get('https://example.com/b')).toBeDefined();
  });

  it('stmtClearDetailsForUrl deletes only the matching deep_details row', () => {
    const db = freshDb();
    stmtSetDetail(db).run('https://example.com/a', '{}', 1000);
    stmtSetDetail(db).run('https://example.com/b', '{}', 1000);

    stmtClearDetailsForUrl(db).run('https://example.com/a');

    expect(stmtGetDetail(db).get('https://example.com/a')).toBeUndefined();
    expect(stmtGetDetail(db).get('https://example.com/b')).toBeDefined();
  });

  it('stmtClearSearchForUrl reports 1 change when a row matched and 0 when it did not', () => {
    const db = freshDb();
    stmtSetSearch(db).run('https://example.com/a', '[]', 1000, 0);

    expect(stmtClearSearchForUrl(db).run('https://example.com/a').changes).toBe(1);
    expect(stmtClearSearchForUrl(db).run('https://example.com/a').changes).toBe(0);
  });

  it('stmtClearDetailsForUrl reports 1 change when a row matched and 0 when it did not', () => {
    const db = freshDb();
    stmtSetDetail(db).run('https://example.com/a', '{}', 1000);

    expect(stmtClearDetailsForUrl(db).run('https://example.com/a').changes).toBe(1);
    expect(stmtClearDetailsForUrl(db).run('https://example.com/a').changes).toBe(0);
  });
});

describe('stmtGetOldestAlertEnabledSavedSearch', () => {
  function freshDb(): Database.Database {
    const db = new Database(':memory:');
    initSchema(db);
    return db;
  }

  it('ignores saved searches with should_alert_on_new_listings unset', () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run('s1', 'Alert search', '[]', null, null, 1000, 1);
    stmtInsertSavedSearch(db).run('s2', 'Silent search', '[]', null, null, 2000, 0);

    expect(stmtGetOldestAlertEnabledSavedSearch(db).get()?.id).toBe('s1');
  });

  it('returns undefined when no saved search has alerts enabled', () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run('s1', 'Silent search', '[]', null, null, 1000, 0);

    expect(stmtGetOldestAlertEnabledSavedSearch(db).get()).toBeUndefined();
  });

  it('prefers a saved search that has never run over one with any last_run_at', () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run('s1', 'Ran once', '[]', null, null, 1000, 1);
    stmtUpdateSavedSearchLastRunAt(db).run(500, 's1');
    stmtInsertSavedSearch(db).run('s2', 'Never run', '[]', null, null, 2000, 1);

    expect(stmtGetOldestAlertEnabledSavedSearch(db).get()?.id).toBe('s2');
  });

  it('prefers the saved search with the older last_run_at', () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run('s1', 'Ran recently', '[]', null, null, 1000, 1);
    stmtUpdateSavedSearchLastRunAt(db).run(2000, 's1');
    stmtInsertSavedSearch(db).run('s2', 'Ran long ago', '[]', null, null, 1000, 1);
    stmtUpdateSavedSearchLastRunAt(db).run(500, 's2');

    expect(stmtGetOldestAlertEnabledSavedSearch(db).get()?.id).toBe('s2');
  });

  it('breaks a tied last_run_at by insertion order', () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run('s1', 'Inserted first', '[]', null, null, 1000, 1);
    stmtInsertSavedSearch(db).run('s2', 'Inserted second', '[]', null, null, 1000, 1);

    expect(stmtGetOldestAlertEnabledSavedSearch(db).get()?.id).toBe('s1');
  });
});

describe('stmtGetSavedSearchByName', () => {
  function freshDb(): Database.Database {
    const db = new Database(':memory:');
    initSchema(db);
    return db;
  }

  it('finds a saved search by its exact name', () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run('s1', 'Vintage lamps', '[]', null, null, 1000, 0);

    expect(stmtGetSavedSearchByName(db).get('Vintage lamps')?.id).toBe('s1');
  });

  it('returns undefined when no saved search has that name', () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run('s1', 'Vintage lamps', '[]', null, null, 1000, 0);

    expect(stmtGetSavedSearchByName(db).get('Something else')).toBeUndefined();
  });
});

describe('stmtUpdateSavedSearch', () => {
  function freshDb(): Database.Database {
    const db = new Database(':memory:');
    initSchema(db);
    return db;
  }

  it('replaces name, urls, discover_inputs and ai_filter, leaving other columns untouched', () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run('s1', 'Original name', '["https://a"]', null, null, 1000, 1);
    stmtUpdateSavedSearchLastRunAt(db).run(5000, 's1');

    stmtUpdateSavedSearch(db).run(
      'Updated name',
      '["https://b"]',
      '{"prompt":"lamp"}',
      'no rust',
      's1'
    );

    const row = stmtGetSavedSearchByName(db).get('Updated name');
    expect(row?.id).toBe('s1');
    expect(row?.urls).toBe('["https://b"]');
    expect(row?.discover_inputs).toBe('{"prompt":"lamp"}');
    expect(row?.ai_filter).toBe('no rust');
    expect(row?.created_at).toBe(1000);
    expect(row?.should_alert_on_new_listings).toBe(1);
    expect(row?.last_run_at).toBe(5000);
  });
});

describe('isUniqueConstraintViolation', () => {
  function freshDb(): Database.Database {
    const db = new Database(':memory:');
    initSchema(db);
    return db;
  }

  it('returns true for a UNIQUE constraint failure thrown by better-sqlite3', () => {
    const db = freshDb();
    stmtInsertSavedSearch(db).run('s1', 'Vintage lamps', '[]', null, null, 1000, 0);

    let caughtErr: unknown;
    try {
      stmtInsertSavedSearch(db).run('s2', 'Vintage lamps', '[]', null, null, 2000, 0);
    } catch (err) {
      caughtErr = err;
    }
    expect(isUniqueConstraintViolation(caughtErr)).toBe(true);
  });

  it('returns false for an unrelated error', () => {
    expect(isUniqueConstraintViolation(new Error('boom'))).toBe(false);
    expect(isUniqueConstraintViolation('not an error')).toBe(false);
  });
});

describe('configureDatabaseConnection', () => {
  let tmpDbPath: string;

  afterEach(() => {
    if (tmpDbPath && fs.existsSync(tmpDbPath)) {
      fs.rmSync(tmpDbPath);
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(tmpDbPath + suffix)) fs.rmSync(tmpDbPath + suffix);
      }
    }
  });

  it("enables WAL journal mode so concurrent readers/writers from multiple processes don't block", () => {
    tmpDbPath = path.join(os.tmpdir(), `sifty-test-${Date.now()}.db`);
    const db = new Database(tmpDbPath);
    configureDatabaseConnection(db);
    const rows = db.pragma('journal_mode', { simple: false }) as Array<{ journal_mode: string }>;
    expect(rows[0].journal_mode).toBe('wal');
  });

  it('sets a non-zero busy timeout so a lock from a concurrent worktree process is retried instead of throwing immediately', () => {
    tmpDbPath = path.join(os.tmpdir(), `sifty-test-${Date.now()}.db`);
    const db = new Database(tmpDbPath);
    configureDatabaseConnection(db);
    const rows = db.pragma('busy_timeout', { simple: false }) as Array<{ timeout: number }>;
    expect(rows[0].timeout).toBeGreaterThan(0);
  });
});
