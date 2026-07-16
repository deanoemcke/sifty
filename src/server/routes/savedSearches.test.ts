import type { ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let _testDb: Database.Database | null = null;

function requireTestDb(): Database.Database {
  if (!_testDb) throw new Error('test DB not initialised');
  return _testDb;
}

vi.mock('../db', () => {
  function getDb(): Database.Database {
    if (!_testDb) throw new Error('test DB not initialised');
    return _testDb;
  }

  function isUniqueConstraintViolation(err: unknown): boolean {
    return err instanceof Database.SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE';
  }

  function stmtListSavedSearches(db: Database.Database) {
    return db.prepare(
      'SELECT id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings FROM saved_searches ORDER BY created_at DESC'
    );
  }

  function stmtGetSavedSearch(db: Database.Database) {
    return db.prepare(
      'SELECT id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings FROM saved_searches WHERE id = ?'
    );
  }

  // vi.fn-wrapped (not a plain function) so individual tests can override its
  // return value once, to simulate a concurrent create/rename racing past the
  // check-then-act existence check right before this call's INSERT/UPDATE runs.
  const stmtGetSavedSearchByName = vi.fn((db: Database.Database) =>
    db.prepare(
      'SELECT id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings FROM saved_searches WHERE name = ?'
    )
  );

  function stmtInsertSavedSearch(db: Database.Database) {
    return db.prepare(
      'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
  }

  function stmtDeleteSavedSearch(db: Database.Database) {
    return db.prepare('DELETE FROM saved_searches WHERE id = ?');
  }

  function stmtUpdateSavedSearchAlert(db: Database.Database) {
    return db.prepare('UPDATE saved_searches SET should_alert_on_new_listings = ? WHERE id = ?');
  }

  function stmtUpdateSavedSearch(db: Database.Database) {
    return db.prepare(
      'UPDATE saved_searches SET name = ?, urls = ?, discover_inputs = ?, ai_filter = ? WHERE id = ?'
    );
  }

  return {
    getDb,
    isUniqueConstraintViolation,
    stmtListSavedSearches,
    stmtGetSavedSearch,
    stmtGetSavedSearchByName,
    stmtInsertSavedSearch,
    stmtDeleteSavedSearch,
    stmtUpdateSavedSearchAlert,
    stmtUpdateSavedSearch,
  };
});

vi.mock('../helpers', () => ({
  readBody: vi.fn(),
  sendJSON: vi.fn(),
}));

import { stmtGetSavedSearchByName } from '../db';
import { readBody, sendJSON } from '../helpers';
import {
  handleCreateSavedSearch,
  handleDeleteSavedSearch,
  handleGetSavedSearch,
  handleListSavedSearches,
  handlePatchSavedSearch,
  handleUpdateSavedSearch,
} from './savedSearches';

function makeResponse(): ServerResponse {
  return {} as ServerResponse;
}

function initTestDb(): void {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE saved_searches (
      id                           TEXT PRIMARY KEY,
      name                         TEXT NOT NULL,
      urls                         TEXT NOT NULL,
      discover_inputs              TEXT,
      ai_filter                    TEXT,
      created_at                   INTEGER NOT NULL,
      should_alert_on_new_listings INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_saved_searches_name ON saved_searches(name);
  `);
  _testDb = db;
}

beforeEach(() => {
  initTestDb();
  vi.mocked(sendJSON).mockClear();
  vi.mocked(readBody).mockClear();
  vi.mocked(stmtGetSavedSearchByName).mockClear();
});

describe('handleCreateSavedSearch', () => {
  it('accepts a POST without a filters field', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'My search',
      urls: ['https://www.trademe.co.nz/a/x'],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ ok: true })
    );
  });

  it('stores discoverInputs and retrieves them via GET', async () => {
    const discoverInputs = {
      prompt: 'macbook pro m3',
      maxPrice: 2000,
      fulfillment: 'pickup',
      region: '2',
    };

    vi.mocked(readBody).mockResolvedValue({
      name: 'MacBook hunt',
      urls: ['https://www.trademe.co.nz/a/x'],
      discoverInputs,
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    const createCall = vi.mocked(sendJSON).mock.calls[0];
    expect(createCall[1]).toBe(200);
    const { id } = createCall[2] as { ok: boolean; id: string };

    vi.mocked(sendJSON).mockClear();
    handleGetSavedSearch(makeResponse() as never, makeResponse(), id);

    const getCall = vi.mocked(sendJSON).mock.calls[0];
    expect(getCall[1]).toBe(200);
    const { search } = getCall[2] as { search: Record<string, unknown> };
    expect(search.discoverInputs).toEqual(discoverInputs);
    expect(search).not.toHaveProperty('filters');
  });

  it('returns 400 when discoverInputs is a string', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'My search',
      urls: ['https://www.trademe.co.nz/a/x'],
      discoverInputs: 'not-an-object',
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ error: expect.stringContaining('discoverInputs') })
    );
  });

  it('returns 400 when discoverInputs is an array', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'My search',
      urls: ['https://www.trademe.co.nz/a/x'],
      discoverInputs: ['prompt', 'something'],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ error: expect.stringContaining('discoverInputs') })
    );
  });

  it('returns 400 when discoverInputs exceeds the size limit', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'My search',
      urls: ['https://www.trademe.co.nz/a/x'],
      discoverInputs: { prompt: 'x'.repeat(5000) },
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ error: expect.stringContaining('discoverInputs') })
    );
  });

  it('returns 400 when name is missing', async () => {
    vi.mocked(readBody).mockResolvedValue({
      urls: ['https://www.trademe.co.nz/a/x'],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(expect.anything(), 400, expect.anything());
  });

  it('stores null for discoverInputs when not provided', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'Plain search',
      urls: ['https://www.trademe.co.nz/a/x'],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    handleGetSavedSearch(makeResponse() as never, makeResponse(), id);

    const { search } = vi.mocked(sendJSON).mock.calls[0][2] as { search: Record<string, unknown> };
    expect(search.discoverInputs).toBeNull();
  });

  it('defaults shouldAlertOnNewListings to false when not provided', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'Plain search',
      urls: ['https://www.trademe.co.nz/a/x'],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    handleGetSavedSearch(makeResponse() as never, makeResponse(), id);

    const { search } = vi.mocked(sendJSON).mock.calls[0][2] as { search: Record<string, unknown> };
    expect(search.shouldAlertOnNewListings).toBe(false);
  });

  it('stores shouldAlertOnNewListings when set true on create', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'Plain search',
      urls: ['https://www.trademe.co.nz/a/x'],
      shouldAlertOnNewListings: true,
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    handleGetSavedSearch(makeResponse() as never, makeResponse(), id);

    const { search } = vi.mocked(sendJSON).mock.calls[0][2] as { search: Record<string, unknown> };
    expect(search.shouldAlertOnNewListings).toBe(true);
  });

  it('returns 400 when shouldAlertOnNewListings is not a boolean', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'Plain search',
      urls: ['https://www.trademe.co.nz/a/x'],
      shouldAlertOnNewListings: 'yes',
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ error: expect.stringContaining('shouldAlertOnNewListings') })
    );
  });

  it('returns 409 with the existing id when name already exists, and does not insert a duplicate', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'Duplicate name',
      urls: ['https://www.trademe.co.nz/a/x'],
    });
    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id: firstId } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    vi.mocked(readBody).mockResolvedValue({
      name: 'Duplicate name',
      urls: ['https://www.trademe.co.nz/a/y'],
    });
    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ existingId: firstId })
    );

    vi.mocked(sendJSON).mockClear();
    handleListSavedSearches(makeResponse() as never, makeResponse());
    const { searches } = vi.mocked(sendJSON).mock.calls[0][2] as { searches: unknown[] };
    expect(searches).toHaveLength(1);
  });

  it('returns 409 via the UNIQUE-index catch path when a concurrent create races past the existence check', async () => {
    // Simulates the race the check-then-act SELECT can't close: another
    // request's INSERT for the same name has already committed by the time
    // this one reaches its own INSERT, but this call's existence check ran
    // (and returned nothing) before that happened.
    requireTestDb()
      .prepare(
        'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at, should_alert_on_new_listings) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'winner-of-race',
        'Raced name',
        '["https://www.trademe.co.nz/a/x"]',
        null,
        null,
        1000,
        0
      );
    vi.mocked(stmtGetSavedSearchByName).mockReturnValueOnce({
      get: () => undefined,
    } as unknown as ReturnType<typeof stmtGetSavedSearchByName>);

    vi.mocked(readBody).mockResolvedValue({
      name: 'Raced name',
      urls: ['https://www.trademe.co.nz/a/z'],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({
        error: 'A saved search with this name already exists',
        existingId: 'winner-of-race',
      })
    );

    vi.mocked(sendJSON).mockClear();
    handleListSavedSearches(makeResponse() as never, makeResponse());
    const { searches } = vi.mocked(sendJSON).mock.calls[0][2] as { searches: unknown[] };
    expect(searches).toHaveLength(1);
  });
});

describe('handleListSavedSearches', () => {
  it('returns 500 when a row contains corrupt urls JSON', () => {
    requireTestDb()
      .prepare(
        'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('bad-id', 'bad row', 'not-json', null, null, Date.now());

    handleListSavedSearches(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      500,
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('returns discoverInputs not filters in the list', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'Test',
      urls: ['https://www.trademe.co.nz/a/x'],
      discoverInputs: { prompt: 'laptop', fulfillment: 'any' },
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    vi.mocked(sendJSON).mockClear();

    handleListSavedSearches(makeResponse() as never, makeResponse());

    const { searches } = vi.mocked(sendJSON).mock.calls[0][2] as {
      searches: Record<string, unknown>[];
    };
    expect(searches).toHaveLength(1);
    expect(searches[0]).toHaveProperty('discoverInputs');
    expect(searches[0]).not.toHaveProperty('filters');
  });
});

describe('handleGetSavedSearch', () => {
  it('returns 500 when the stored row has corrupt urls JSON', () => {
    requireTestDb()
      .prepare(
        'INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('bad-id', 'bad row', 'not-json', null, null, Date.now());

    handleGetSavedSearch(makeResponse() as never, makeResponse(), 'bad-id');

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      500,
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe('handleDeleteSavedSearch', () => {
  it('returns 404 for unknown id', () => {
    handleDeleteSavedSearch(makeResponse() as never, makeResponse(), 'nonexistent-id');

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      404,
      expect.objectContaining({ error: 'Not found' })
    );
  });

  it('deletes an existing saved search', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'To delete',
      urls: ['https://www.trademe.co.nz/a/x'],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    handleDeleteSavedSearch(makeResponse() as never, makeResponse(), id);

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });
  });
});

describe('handlePatchSavedSearch', () => {
  it('returns 404 for unknown id', async () => {
    vi.mocked(readBody).mockResolvedValue({ shouldAlertOnNewListings: true });

    await handlePatchSavedSearch(makeResponse() as never, makeResponse(), 'nonexistent-id');

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      404,
      expect.objectContaining({ error: 'Not found' })
    );
  });

  it('returns 400 when shouldAlertOnNewListings is not a boolean', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'To patch',
      urls: ['https://www.trademe.co.nz/a/x'],
    });
    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    vi.mocked(readBody).mockResolvedValue({ shouldAlertOnNewListings: 'yes' });
    await handlePatchSavedSearch(makeResponse() as never, makeResponse(), id);

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ error: expect.stringContaining('shouldAlertOnNewListings') })
    );
  });

  it('toggles shouldAlertOnNewListings on an existing saved search', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'To patch',
      urls: ['https://www.trademe.co.nz/a/x'],
    });
    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    vi.mocked(readBody).mockResolvedValue({ shouldAlertOnNewListings: true });
    await handlePatchSavedSearch(makeResponse() as never, makeResponse(), id);

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });

    vi.mocked(sendJSON).mockClear();
    handleGetSavedSearch(makeResponse() as never, makeResponse(), id);
    const { search } = vi.mocked(sendJSON).mock.calls[0][2] as { search: Record<string, unknown> };
    expect(search.shouldAlertOnNewListings).toBe(true);
  });
});

describe('handleUpdateSavedSearch', () => {
  it('returns 404 for unknown id', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'Updated',
      urls: ['https://www.trademe.co.nz/a/x'],
    });

    await handleUpdateSavedSearch(makeResponse() as never, makeResponse(), 'nonexistent-id');

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      404,
      expect.objectContaining({ error: 'Not found' })
    );
  });

  it('returns 400 when urls is missing', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'To update',
      urls: ['https://www.trademe.co.nz/a/x'],
    });
    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    vi.mocked(readBody).mockResolvedValue({ name: 'To update' });
    await handleUpdateSavedSearch(makeResponse() as never, makeResponse(), id);

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ error: expect.stringContaining('urls') })
    );
  });

  it('updates name, urls, aiFilter and discoverInputs while preserving id, createdAt and shouldAlertOnNewListings', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'Original name',
      urls: ['https://www.trademe.co.nz/a/original'],
      shouldAlertOnNewListings: true,
    });
    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    handleGetSavedSearch(makeResponse() as never, makeResponse(), id);
    const before = (vi.mocked(sendJSON).mock.calls[0][2] as { search: Record<string, unknown> })
      .search;

    vi.mocked(sendJSON).mockClear();
    vi.mocked(readBody).mockResolvedValue({
      name: 'Updated name',
      urls: ['https://www.trademe.co.nz/a/updated'],
      aiFilter: 'good condition only',
      discoverInputs: { prompt: 'lamp', fulfillment: 'any' },
    });
    await handleUpdateSavedSearch(makeResponse() as never, makeResponse(), id);

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });

    vi.mocked(sendJSON).mockClear();
    handleGetSavedSearch(makeResponse() as never, makeResponse(), id);
    const { search: after } = vi.mocked(sendJSON).mock.calls[0][2] as {
      search: Record<string, unknown>;
    };

    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.shouldAlertOnNewListings).toBe(true);
    expect(after.name).toBe('Updated name');
    expect(after.urls).toEqual(['https://www.trademe.co.nz/a/updated']);
    expect(after.aiFilter).toBe('good condition only');
    expect(after.discoverInputs).toEqual({ prompt: 'lamp', fulfillment: 'any' });
  });

  it('returns 409 and leaves the row unrenamed when renaming into a name already used by another saved search', async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: 'Taken name',
      urls: ['https://www.trademe.co.nz/a/x'],
    });
    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id: otherId } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    vi.mocked(readBody).mockResolvedValue({
      name: 'To rename',
      urls: ['https://www.trademe.co.nz/a/y'],
    });
    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    vi.mocked(readBody).mockResolvedValue({
      name: 'Taken name',
      urls: ['https://www.trademe.co.nz/a/y'],
    });
    await handleUpdateSavedSearch(makeResponse() as never, makeResponse(), id);

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({
        error: 'A saved search with this name already exists',
        existingId: otherId,
      })
    );

    vi.mocked(sendJSON).mockClear();
    handleGetSavedSearch(makeResponse() as never, makeResponse(), id);
    const { search } = vi.mocked(sendJSON).mock.calls[0][2] as { search: Record<string, unknown> };
    expect(search.name).toBe('To rename');
  });
});
