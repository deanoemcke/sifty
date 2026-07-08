import type { ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

let _testDb: Database.Database | null = null;

function requireTestDb(): Database.Database {
  if (!_testDb) throw new Error("test DB not initialised");
  return _testDb;
}

vi.mock("../db", () => {
  function getDb(): Database.Database {
    if (!_testDb) throw new Error("test DB not initialised");
    return _testDb;
  }

  function stmtListSavedSearches(db: Database.Database) {
    return db.prepare(
      "SELECT id, name, urls, discover_inputs, ai_filter, created_at FROM saved_searches ORDER BY created_at DESC",
    );
  }

  function stmtGetSavedSearch(db: Database.Database) {
    return db.prepare(
      "SELECT id, name, urls, discover_inputs, ai_filter, created_at FROM saved_searches WHERE id = ?",
    );
  }

  function stmtInsertSavedSearch(db: Database.Database) {
    return db.prepare(
      "INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
  }

  function stmtDeleteSavedSearch(db: Database.Database) {
    return db.prepare("DELETE FROM saved_searches WHERE id = ?");
  }

  return {
    getDb,
    stmtListSavedSearches,
    stmtGetSavedSearch,
    stmtInsertSavedSearch,
    stmtDeleteSavedSearch,
  };
});

vi.mock("../helpers", () => ({
  readBody: vi.fn(),
  sendJSON: vi.fn(),
}));

import { readBody, sendJSON } from "../helpers";
import {
  handleCreateSavedSearch,
  handleDeleteSavedSearch,
  handleGetSavedSearch,
  handleListSavedSearches,
} from "./savedSearches";

function makeResponse(): ServerResponse {
  return {} as ServerResponse;
}

function initTestDb(): void {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE saved_searches (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      urls            TEXT NOT NULL,
      discover_inputs TEXT,
      ai_filter       TEXT,
      created_at      INTEGER NOT NULL
    );
  `);
  _testDb = db;
}

beforeEach(() => {
  initTestDb();
  vi.mocked(sendJSON).mockClear();
  vi.mocked(readBody).mockClear();
});

describe("handleCreateSavedSearch", () => {
  it("accepts a POST without a filters field", async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: "My search",
      urls: ["https://www.trademe.co.nz/a/x"],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ ok: true }),
    );
  });

  it("stores discoverInputs and retrieves them via GET", async () => {
    const discoverInputs = {
      prompt: "macbook pro m3",
      maxPrice: 2000,
      fulfillment: "pickup",
      region: "2",
    };

    vi.mocked(readBody).mockResolvedValue({
      name: "MacBook hunt",
      urls: ["https://www.trademe.co.nz/a/x"],
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
    expect(search).not.toHaveProperty("filters");
  });

  it("returns 400 when discoverInputs is a string", async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: "My search",
      urls: ["https://www.trademe.co.nz/a/x"],
      discoverInputs: "not-an-object",
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ error: expect.stringContaining("discoverInputs") }),
    );
  });

  it("returns 400 when discoverInputs is an array", async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: "My search",
      urls: ["https://www.trademe.co.nz/a/x"],
      discoverInputs: ["prompt", "something"],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ error: expect.stringContaining("discoverInputs") }),
    );
  });

  it("returns 400 when discoverInputs exceeds the size limit", async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: "My search",
      urls: ["https://www.trademe.co.nz/a/x"],
      discoverInputs: { prompt: "x".repeat(5000) },
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ error: expect.stringContaining("discoverInputs") }),
    );
  });

  it("returns 400 when name is missing", async () => {
    vi.mocked(readBody).mockResolvedValue({
      urls: ["https://www.trademe.co.nz/a/x"],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(expect.anything(), 400, expect.anything());
  });

  it("stores null for discoverInputs when not provided", async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: "Plain search",
      urls: ["https://www.trademe.co.nz/a/x"],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    handleGetSavedSearch(makeResponse() as never, makeResponse(), id);

    const { search } = vi.mocked(sendJSON).mock.calls[0][2] as { search: Record<string, unknown> };
    expect(search.discoverInputs).toBeNull();
  });
});

describe("handleListSavedSearches", () => {
  it("returns 500 when a row contains corrupt urls JSON", () => {
    requireTestDb()
      .prepare(
        "INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("bad-id", "bad row", "not-json", null, null, Date.now());

    handleListSavedSearches(makeResponse() as never, makeResponse());

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      500,
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("returns discoverInputs not filters in the list", async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: "Test",
      urls: ["https://www.trademe.co.nz/a/x"],
      discoverInputs: { prompt: "laptop", fulfillment: "any" },
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    vi.mocked(sendJSON).mockClear();

    handleListSavedSearches(makeResponse() as never, makeResponse());

    const { searches } = vi.mocked(sendJSON).mock.calls[0][2] as {
      searches: Record<string, unknown>[];
    };
    expect(searches).toHaveLength(1);
    expect(searches[0]).toHaveProperty("discoverInputs");
    expect(searches[0]).not.toHaveProperty("filters");
  });
});

describe("handleGetSavedSearch", () => {
  it("returns 500 when the stored row has corrupt urls JSON", () => {
    requireTestDb()
      .prepare(
        "INSERT INTO saved_searches (id, name, urls, discover_inputs, ai_filter, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("bad-id", "bad row", "not-json", null, null, Date.now());

    handleGetSavedSearch(makeResponse() as never, makeResponse(), "bad-id");

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      500,
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});

describe("handleDeleteSavedSearch", () => {
  it("returns 404 for unknown id", () => {
    handleDeleteSavedSearch(makeResponse() as never, makeResponse(), "nonexistent-id");

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(
      expect.anything(),
      404,
      expect.objectContaining({ error: "Not found" }),
    );
  });

  it("deletes an existing saved search", async () => {
    vi.mocked(readBody).mockResolvedValue({
      name: "To delete",
      urls: ["https://www.trademe.co.nz/a/x"],
    });

    await handleCreateSavedSearch(makeResponse() as never, makeResponse());
    const { id } = vi.mocked(sendJSON).mock.calls[0][2] as { id: string };

    vi.mocked(sendJSON).mockClear();
    handleDeleteSavedSearch(makeResponse() as never, makeResponse(), id);

    expect(vi.mocked(sendJSON)).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });
  });
});
