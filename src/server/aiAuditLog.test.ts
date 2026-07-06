import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAuditEntry } from "./aiAuditLog";
import {
  appendAuditLogLineAsync,
  formatAuditEntryLine,
  writeAuditLogHeaderAsync,
} from "./aiAuditLog";

const SAMPLE_ENTRY: AiAuditEntry = {
  timestamp: "2026-07-07T00:00:00.000Z",
  label: "test-label",
  model: "test-model",
  attempt: 1,
  status: "success",
  systemMessage: "sys",
  userMessage: "usr",
  response: { answer: 42 },
  durationMs: 12,
};

describe("formatAuditEntryLine", () => {
  it("produces a single JSON line ending in a newline", () => {
    const line = formatAuditEntryLine(SAMPLE_ENTRY);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("round-trips every field through JSON.parse", () => {
    const line = formatAuditEntryLine(SAMPLE_ENTRY);
    expect(JSON.parse(line)).toEqual(SAMPLE_ENTRY);
  });
});

describe("writeAuditLogHeaderAsync / appendAuditLogLineAsync", () => {
  let tempDir: string;
  let auditLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-audit-test-"));
    auditLogPath = path.join(tempDir, "nested", "ai-audit.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates an empty file, including missing parent directories", async () => {
    await writeAuditLogHeaderAsync(auditLogPath);
    expect(fs.readFileSync(auditLogPath, "utf-8")).toBe("");
  });

  it("truncates a file that already has content", async () => {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fs.writeFileSync(auditLogPath, "stale content\n");
    await writeAuditLogHeaderAsync(auditLogPath);
    expect(fs.readFileSync(auditLogPath, "utf-8")).toBe("");
  });

  it("appends one JSON line per call without disturbing prior lines", async () => {
    await writeAuditLogHeaderAsync(auditLogPath);
    await appendAuditLogLineAsync(auditLogPath, SAMPLE_ENTRY);
    await appendAuditLogLineAsync(auditLogPath, { ...SAMPLE_ENTRY, attempt: 2, label: "second" });

    const lines = fs.readFileSync(auditLogPath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(SAMPLE_ENTRY);
    expect(JSON.parse(lines[1])).toMatchObject({ attempt: 2, label: "second" });
  });
});

// recordAiAuditEntry() closes over a module-level singleton (the hardcoded AUDIT_LOG_PATH
// and the truncate-once initialization promise), matching aiAuditLog.ts's header comment.
// Each test below resets the module registry and re-imports fresh so the singleton state
// (and the fs/promises spies) never leak between cases.
describe("recordAiAuditEntry (fire-and-forget async writes)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("is fire-and-forget: it returns synchronously without throwing even when the write rejects", async () => {
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "writeFile").mockRejectedValue(new Error("ENOSPC"));
    vi.spyOn(fsPromises, "appendFile").mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { recordAiAuditEntry } = await import("./aiAuditLog");

    let returnValue: unknown;
    expect(() => {
      returnValue = recordAiAuditEntry(SAMPLE_ENTRY);
    }).not.toThrow();
    expect(returnValue).toBeUndefined();

    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    expect(consoleErrorSpy).toHaveBeenCalledWith("[AiAuditLog] write failed", expect.any(Error));
  });

  it("never produces an unhandled promise rejection when the underlying write fails", async () => {
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "appendFile").mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const { recordAiAuditEntry } = await import("./aiAuditLog");
      recordAiAuditEntry(SAMPLE_ENTRY);

      // Give the fire-and-forget chain (and Node's unhandledRejection detection, which
      // fires on the next microtask/macrotask turn) a chance to settle.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toHaveLength(0);
  });

  it("initializes (mkdir + truncate) once per module instance, then appends on every call", async () => {
    const mkdirSpy = vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
    const writeFileSpy = vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    const appendFileSpy = vi.spyOn(fsPromises, "appendFile").mockResolvedValue(undefined);

    const { recordAiAuditEntry } = await import("./aiAuditLog");

    recordAiAuditEntry(SAMPLE_ENTRY);
    recordAiAuditEntry({ ...SAMPLE_ENTRY, attempt: 2 });
    recordAiAuditEntry({ ...SAMPLE_ENTRY, attempt: 3 });

    await vi.waitFor(() => expect(appendFileSpy).toHaveBeenCalledTimes(3));
    expect(mkdirSpy).toHaveBeenCalledTimes(1);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
  });

  it("retries initialization on the next entry after a failed header write", async () => {
    const writeFileSpy = vi
      .spyOn(fsPromises, "writeFile")
      .mockRejectedValueOnce(new Error("EACCES"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
    const appendFileSpy = vi.spyOn(fsPromises, "appendFile").mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { recordAiAuditEntry } = await import("./aiAuditLog");

    recordAiAuditEntry(SAMPLE_ENTRY);
    await vi.waitFor(() => expect(writeFileSpy).toHaveBeenCalledTimes(1));
    // First entry never gets appended because header initialization failed.
    expect(appendFileSpy).not.toHaveBeenCalled();

    recordAiAuditEntry({ ...SAMPLE_ENTRY, attempt: 2 });
    await vi.waitFor(() => expect(appendFileSpy).toHaveBeenCalledTimes(1));
    expect(writeFileSpy).toHaveBeenCalledTimes(2);
  });
});
