import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAuditEntry } from "./aiAuditLog";
import {
  appendAuditLogLineAsync,
  formatAuditEntryLine,
  MAX_AUDIT_FIELD_LENGTH,
  MAX_AUDIT_LOG_FILE_SIZE_BYTES,
  rotateAuditLogIfOversizedAsync,
  truncateAuditField,
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

describe("truncateAuditField", () => {
  it("returns a value at or under the cap unchanged", () => {
    const value = "a".repeat(MAX_AUDIT_FIELD_LENGTH);
    expect(truncateAuditField(value)).toBe(value);
  });

  it("truncates a value over the cap and appends a marker naming the omitted byte count", () => {
    const value = "a".repeat(MAX_AUDIT_FIELD_LENGTH + 500);
    const truncated = truncateAuditField(value);
    expect(truncated.startsWith("a".repeat(MAX_AUDIT_FIELD_LENGTH))).toBe(true);
    expect(truncated).toBe(
      `${"a".repeat(MAX_AUDIT_FIELD_LENGTH)}...[truncated, 500 bytes omitted]`,
    );
  });

  it("counts multi-byte UTF-8 characters in the omitted byte count, not just omitted characters", () => {
    // Every "é" is 2 bytes in UTF-8, so 10 omitted characters is 20 omitted bytes.
    const value = "a".repeat(MAX_AUDIT_FIELD_LENGTH) + "é".repeat(10);
    const truncated = truncateAuditField(value);
    expect(truncated).toContain("...[truncated, 20 bytes omitted]");
  });
});

describe("formatAuditEntryLine field size caps", () => {
  it("truncates an oversized rawContent field with a visible marker", () => {
    const oversizedRawContent = "x".repeat(MAX_AUDIT_FIELD_LENGTH + 5_000);
    const entry: AiAuditEntry = {
      ...SAMPLE_ENTRY,
      response: undefined,
      rawContent: oversizedRawContent,
    };

    const parsed = JSON.parse(formatAuditEntryLine(entry));

    expect(parsed.rawContent).toContain("...[truncated, 5000 bytes omitted]");
    expect(parsed.rawContent.length).toBeLessThan(oversizedRawContent.length);
  });

  it("leaves a rawContent field under the cap untouched", () => {
    const entry: AiAuditEntry = {
      ...SAMPLE_ENTRY,
      response: undefined,
      rawContent: "short content",
    };

    const parsed = JSON.parse(formatAuditEntryLine(entry));

    expect(parsed.rawContent).toBe("short content");
  });

  it("truncates an oversized response field (by its serialized size) into a marked string", () => {
    const entry: AiAuditEntry = {
      ...SAMPLE_ENTRY,
      response: { data: "x".repeat(MAX_AUDIT_FIELD_LENGTH + 10) },
    };

    const parsed = JSON.parse(formatAuditEntryLine(entry));

    expect(typeof parsed.response).toBe("string");
    expect(parsed.response).toContain("...[truncated,");
  });

  it("leaves a response field under the cap as the original structured value", () => {
    const line = formatAuditEntryLine(SAMPLE_ENTRY);
    expect(JSON.parse(line).response).toEqual(SAMPLE_ENTRY.response);
  });

  it("truncates an oversized systemMessage field with a visible marker", () => {
    const oversizedSystemMessage = "x".repeat(MAX_AUDIT_FIELD_LENGTH + 5_000);
    const entry: AiAuditEntry = {
      ...SAMPLE_ENTRY,
      response: undefined,
      systemMessage: oversizedSystemMessage,
    };

    const parsed = JSON.parse(formatAuditEntryLine(entry));

    expect(parsed.systemMessage).toContain("...[truncated, 5000 bytes omitted]");
    expect(parsed.systemMessage.length).toBeLessThan(oversizedSystemMessage.length);
  });

  it("truncates an oversized userMessage field with a visible marker", () => {
    const oversizedUserMessage = "x".repeat(MAX_AUDIT_FIELD_LENGTH + 5_000);
    const entry: AiAuditEntry = {
      ...SAMPLE_ENTRY,
      response: undefined,
      userMessage: oversizedUserMessage,
    };

    const parsed = JSON.parse(formatAuditEntryLine(entry));

    expect(parsed.userMessage).toContain("...[truncated, 5000 bytes omitted]");
    expect(parsed.userMessage.length).toBeLessThan(oversizedUserMessage.length);
  });

  it("truncates an oversized errorMessage field with a visible marker", () => {
    const oversizedErrorMessage = "x".repeat(MAX_AUDIT_FIELD_LENGTH + 5_000);
    const entry: AiAuditEntry = {
      ...SAMPLE_ENTRY,
      response: undefined,
      errorMessage: oversizedErrorMessage,
    };

    const parsed = JSON.parse(formatAuditEntryLine(entry));

    expect(parsed.errorMessage).toContain("...[truncated, 5000 bytes omitted]");
    expect(parsed.errorMessage.length).toBeLessThan(oversizedErrorMessage.length);
  });

  it("leaves systemMessage, userMessage, and errorMessage under the cap untouched", () => {
    const entry: AiAuditEntry = {
      ...SAMPLE_ENTRY,
      response: undefined,
      systemMessage: "short system",
      userMessage: "short user",
      errorMessage: "short error",
    };

    const parsed = JSON.parse(formatAuditEntryLine(entry));

    expect(parsed.systemMessage).toBe("short system");
    expect(parsed.userMessage).toBe("short user");
    expect(parsed.errorMessage).toBe("short error");
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

  describe("rotateAuditLogIfOversizedAsync", () => {
    it("treats a missing file as size zero and does not throw or rotate", async () => {
      await expect(rotateAuditLogIfOversizedAsync(auditLogPath, 10)).resolves.toBeUndefined();
      expect(fs.existsSync(`${auditLogPath}.1`)).toBe(false);
    });

    it("does not rotate a file under the size threshold", async () => {
      await writeAuditLogHeaderAsync(auditLogPath);
      fs.writeFileSync(auditLogPath, "x".repeat(50));

      await rotateAuditLogIfOversizedAsync(auditLogPath, 1_000);

      expect(fs.existsSync(`${auditLogPath}.1`)).toBe(false);
      expect(fs.readFileSync(auditLogPath, "utf-8")).toBe("x".repeat(50));
    });

    it("rotates a file at or over the size threshold to a .1 suffix", async () => {
      await writeAuditLogHeaderAsync(auditLogPath);
      fs.writeFileSync(auditLogPath, "x".repeat(100));

      await rotateAuditLogIfOversizedAsync(auditLogPath, 50);

      const rotatedPath = `${auditLogPath}.1`;
      expect(fs.existsSync(rotatedPath)).toBe(true);
      expect(fs.readFileSync(rotatedPath, "utf-8")).toBe("x".repeat(100));
      expect(fs.existsSync(auditLogPath)).toBe(false);
    });

    it("overwrites a previous .1 rotation rather than accumulating generations", async () => {
      const rotatedPath = `${auditLogPath}.1`;
      fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
      fs.writeFileSync(rotatedPath, "stale rotation\n");
      fs.writeFileSync(auditLogPath, "x".repeat(100));

      await rotateAuditLogIfOversizedAsync(auditLogPath, 50);

      expect(fs.readFileSync(rotatedPath, "utf-8")).toBe("x".repeat(100));
    });
  });

  describe("appendAuditLogLineAsync file-size guard", () => {
    it("rotates the log file to a .1 suffix once it exceeds the threshold, then starts a fresh file", async () => {
      await writeAuditLogHeaderAsync(auditLogPath);
      fs.writeFileSync(auditLogPath, "x".repeat(100));

      await appendAuditLogLineAsync(auditLogPath, SAMPLE_ENTRY, 50);

      const rotatedPath = `${auditLogPath}.1`;
      expect(fs.readFileSync(rotatedPath, "utf-8")).toBe("x".repeat(100));

      const currentLines = fs.readFileSync(auditLogPath, "utf-8").split("\n").filter(Boolean);
      expect(currentLines).toHaveLength(1);
      expect(JSON.parse(currentLines[0])).toEqual(SAMPLE_ENTRY);
    });

    it("does not rotate when the file is under the size threshold", async () => {
      await writeAuditLogHeaderAsync(auditLogPath);
      await appendAuditLogLineAsync(auditLogPath, SAMPLE_ENTRY, 1_000_000);

      expect(fs.existsSync(`${auditLogPath}.1`)).toBe(false);
    });
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

  it("does not drop an entry when two concurrent calls both observe an oversized log (rotation race)", async () => {
    // Models the real TOCTOU race: `hasRotated` stands in for the on-disk file state.
    // Both concurrent calls' `stat` land before either has rotated (oversized), but the
    // second call's `rename` must only be attempted if the file is still un-rotated by
    // the time it actually runs — which is only guaranteed if the two calls are
    // serialized. An unserialized second call sees `hasRotated` still false (from the
    // race), attempts `rename` again, and gets ENOENT because the first rename already
    // moved the source file.
    let hasRotated = false;
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "stat").mockImplementation(async () => {
      return { size: hasRotated ? 0 : MAX_AUDIT_LOG_FILE_SIZE_BYTES } as fs.Stats;
    });
    vi.spyOn(fsPromises, "rename").mockImplementation(async () => {
      if (hasRotated) {
        const enoentError = new Error(
          "ENOENT: no such file or directory, rename",
        ) as NodeJS.ErrnoException;
        enoentError.code = "ENOENT";
        throw enoentError;
      }
      hasRotated = true;
    });
    const appendFileSpy = vi.spyOn(fsPromises, "appendFile").mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { recordAiAuditEntry } = await import("./aiAuditLog");

    recordAiAuditEntry({ ...SAMPLE_ENTRY, attempt: 1 });
    recordAiAuditEntry({ ...SAMPLE_ENTRY, attempt: 2 });

    await vi.waitFor(() => expect(appendFileSpy).toHaveBeenCalledTimes(2));
    expect(consoleErrorSpy).not.toHaveBeenCalled();
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
