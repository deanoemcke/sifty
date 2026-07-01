import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initSchema } from "./db";

function columnNames(db: Database.Database, table: string): string[] {
  return db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name);
}

describe("initSchema", () => {
  it("creates all tables on a fresh database", () => {
    const db = new Database(":memory:");
    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, "quick_searches")).toContain("url");
    expect(columnNames(db, "deep_details")).toContain("url");
    expect(columnNames(db, "saved_searches")).toContain("id");
    expect(columnNames(db, "trademe_categories")).toContain("slug");
  });

  it("saved_searches has discover_inputs column, not filters", () => {
    const db = new Database(":memory:");
    initSchema(db);
    const cols = columnNames(db, "saved_searches");
    expect(cols).toContain("discover_inputs");
    expect(cols).not.toContain("filters");
  });

  it("quick_searches does not have is_complete column", () => {
    const db = new Database(":memory:");
    initSchema(db);
    expect(columnNames(db, "quick_searches")).not.toContain("is_complete");
  });

  it("is idempotent — calling twice drops and recreates cleanly", () => {
    const db = new Database(":memory:");
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    expect(columnNames(db, "saved_searches")).toContain("discover_inputs");
  });
});
