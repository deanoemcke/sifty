import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDatabaseConnection, initSchema } from './db';

function columnNames(db: Database.Database, table: string): string[] {
  return db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
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

  it('preserves existing data when called on an existing database', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare(
      'INSERT INTO trademe_categories (slug, display, depth, parent_slug, top2) VALUES (?, ?, ?, ?, ?)'
    ).run('electronics', 'Electronics', 1, null, 'electronics');
    initSchema(db);
    const count = db
      .prepare<[], { n: number }>('SELECT COUNT(*) as n FROM trademe_categories')
      .get()?.n;
    expect(count).toBe(1);
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
