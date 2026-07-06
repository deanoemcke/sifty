// Server-side only — detailed audit trail for every request/response sent to the AI provider.
// The log file is recreated (truncated) on first write of each process, then appended to
// for the rest of that process's lifetime, mirroring db.ts's lazy getDb() singleton.

import fs from "node:fs";
import path from "node:path";

export type AiAuditStatus =
  | "success"
  | "rate_limited"
  | "http_error"
  | "network_error"
  | "parse_error"
  | "budget_exceeded";

export type AiAuditEntry = {
  timestamp: string;
  label: string;
  model: string;
  attempt: number;
  status: AiAuditStatus;
  systemMessage: string;
  userMessage: string;
  durationMs: number;
  httpStatus?: number;
  response?: unknown;
  rawContent?: string;
  errorMessage?: string;
};

export function formatAuditEntryLine(entry: AiAuditEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

export function writeAuditLogHeader(auditLogPath: string): void {
  fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
  fs.writeFileSync(auditLogPath, "");
}

export function appendAuditLogLine(auditLogPath: string, entry: AiAuditEntry): void {
  fs.appendFileSync(auditLogPath, formatAuditEntryLine(entry));
}

const AUDIT_LOG_PATH = path.resolve(__dirname, "../../.cache/ai-audit.jsonl");

let initialized = false;

export function recordAiAuditEntry(entry: AiAuditEntry): void {
  if (!initialized) {
    writeAuditLogHeader(AUDIT_LOG_PATH);
    initialized = true;
  }
  appendAuditLogLine(AUDIT_LOG_PATH, entry);
}
