import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let _testDb: Database.Database | null = null;

function requireTestDb(): Database.Database {
  if (!_testDb) throw new Error('test DB not initialised');
  return _testDb;
}

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, getDb: () => requireTestDb() };
});

import { initSchema, stmtGetDetail, stmtGetSearch, stmtSetDetail, stmtSetSearch } from '../db';
import { handleCacheClear } from './cacheRoutes';

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';

function initTestDb(): void {
  const db = new Database(':memory:');
  initSchema(db);
  _testDb = db;
}

function makeRequest(body: unknown): IncomingMessage {
  const stream = new PassThrough();
  stream.end(JSON.stringify(body));
  return stream as unknown as IncomingMessage;
}

function makeResponse(): ServerResponse & { statusCode: number; body: unknown } {
  const response = {
    statusCode: 0,
    body: undefined,
    writeHead(status: number) {
      response.statusCode = status;
      return response;
    },
    end(json: string) {
      response.body = JSON.parse(json);
    },
  } as unknown as ServerResponse & { statusCode: number; body: unknown };
  return response;
}

beforeEach(() => {
  initTestDb();
});

describe('handleCacheClear — quick-search', () => {
  it('clears only the given url, leaving other rows intact', async () => {
    const db = requireTestDb();
    stmtSetSearch(db).run(URL_A, '[]', 1000, 0);
    stmtSetSearch(db).run(URL_B, '[]', 1000, 0);

    await handleCacheClear(makeRequest({ type: 'quick-search', url: URL_A }), makeResponse());

    expect(stmtGetSearch(db).get(URL_A)).toBeUndefined();
    expect(stmtGetSearch(db).get(URL_B)).toBeDefined();
  });

  it('clears every row when no url is given (backward-compatible fallback)', async () => {
    const db = requireTestDb();
    stmtSetSearch(db).run(URL_A, '[]', 1000, 0);
    stmtSetSearch(db).run(URL_B, '[]', 1000, 0);

    await handleCacheClear(makeRequest({ type: 'quick-search' }), makeResponse());

    expect(stmtGetSearch(db).get(URL_A)).toBeUndefined();
    expect(stmtGetSearch(db).get(URL_B)).toBeUndefined();
  });
});

describe('handleCacheClear — deep-search', () => {
  it('clears only the given url, leaving other rows intact', async () => {
    const db = requireTestDb();
    stmtSetDetail(db).run(URL_A, '{}', 1000);
    stmtSetDetail(db).run(URL_B, '{}', 1000);

    await handleCacheClear(makeRequest({ type: 'deep-search', url: URL_A }), makeResponse());

    expect(stmtGetDetail(db).get(URL_A)).toBeUndefined();
    expect(stmtGetDetail(db).get(URL_B)).toBeDefined();
  });

  it('clears every row when no url is given (backward-compatible fallback)', async () => {
    const db = requireTestDb();
    stmtSetDetail(db).run(URL_A, '{}', 1000);
    stmtSetDetail(db).run(URL_B, '{}', 1000);

    await handleCacheClear(makeRequest({ type: 'deep-search' }), makeResponse());

    expect(stmtGetDetail(db).get(URL_A)).toBeUndefined();
    expect(stmtGetDetail(db).get(URL_B)).toBeUndefined();
  });
});

describe('handleCacheClear — invalid type', () => {
  it('responds 400 for an unknown type', async () => {
    const response = makeResponse();
    await handleCacheClear(makeRequest({ type: 'nonsense' }), response);
    expect(response.statusCode).toBe(400);
  });
});
