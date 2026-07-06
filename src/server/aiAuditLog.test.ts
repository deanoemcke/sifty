import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiAuditEntry } from "./aiAuditLog";
import { appendAuditLogLine, formatAuditEntryLine, writeAuditLogHeader } from "./aiAuditLog";

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

describe("writeAuditLogHeader / appendAuditLogLine", () => {
  let tempDir: string;
  let auditLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-audit-test-"));
    auditLogPath = path.join(tempDir, "nested", "ai-audit.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates an empty file, including missing parent directories", () => {
    writeAuditLogHeader(auditLogPath);
    expect(fs.readFileSync(auditLogPath, "utf-8")).toBe("");
  });

  it("truncates a file that already has content", () => {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fs.writeFileSync(auditLogPath, "stale content\n");
    writeAuditLogHeader(auditLogPath);
    expect(fs.readFileSync(auditLogPath, "utf-8")).toBe("");
  });

  it("appends one JSON line per call without disturbing prior lines", () => {
    writeAuditLogHeader(auditLogPath);
    appendAuditLogLine(auditLogPath, SAMPLE_ENTRY);
    appendAuditLogLine(auditLogPath, { ...SAMPLE_ENTRY, attempt: 2, label: "second" });

    const lines = fs.readFileSync(auditLogPath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(SAMPLE_ENTRY);
    expect(JSON.parse(lines[1])).toMatchObject({ attempt: 2, label: "second" });
  });
});
