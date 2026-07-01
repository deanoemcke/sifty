import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadFixture, saveFixture } from "./fixtureStore";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prompt-test-fixtures-"));
}

describe("saveFixture / loadFixture", () => {
  it("round-trips a fixture to disk and back", () => {
    const baseDir = makeTempDir();
    const response = { results: [{ index: 1, pass: true, reason: null }] };

    saveFixture(baseDir, "groq", "aiFilter-laptop", "llama-3.3-70b", response);
    const fixture = loadFixture(baseDir, "groq", "aiFilter-laptop");

    expect(fixture).not.toBeNull();
    expect(fixture!.response).toEqual(response);
    expect(fixture!.provider).toBe("groq");
    expect(fixture!.testId).toBe("aiFilter-laptop");
    expect(fixture!.model).toBe("llama-3.3-70b");
    expect(typeof fixture!.capturedAt).toBe("string");

    fs.rmSync(baseDir, { recursive: true });
  });

  it("returns null when the fixture file does not exist", () => {
    const baseDir = makeTempDir();
    expect(loadFixture(baseDir, "groq", "nonexistent-test")).toBeNull();
    fs.rmSync(baseDir, { recursive: true });
  });

  it("creates the provider subdirectory if it does not exist", () => {
    const baseDir = makeTempDir();
    saveFixture(baseDir, "openrouter", "aiFilter-laptop", "llama", {});
    expect(fs.existsSync(path.join(baseDir, "openrouter", "aiFilter-laptop.json"))).toBe(true);
    fs.rmSync(baseDir, { recursive: true });
  });

  it("overwrites an existing fixture on save", () => {
    const baseDir = makeTempDir();
    saveFixture(baseDir, "groq", "aiFilter-laptop", "llama", { first: true });
    saveFixture(baseDir, "groq", "aiFilter-laptop", "llama", { second: true });
    const fixture = loadFixture(baseDir, "groq", "aiFilter-laptop");
    expect(fixture!.response).toEqual({ second: true });
    fs.rmSync(baseDir, { recursive: true });
  });
});
