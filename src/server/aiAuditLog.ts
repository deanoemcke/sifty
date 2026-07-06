// Server-side only — detailed audit trail for every request/response sent to the AI provider.
// The log file is recreated (truncated) on first write of each process, then appended to
// for the rest of that process's lifetime, mirroring db.ts's lazy getDb() singleton.
//
// All disk I/O here is async and fire-and-forget: recordAiAuditEntry() never blocks the
// event loop and never throws into its caller. This is a best-effort diagnostic side
// channel, not a transactional record — concurrent AI calls (see ConcurrencyQueue in
// src/lib/queue.ts) must never stall on audit-log disk writes, and a failing write must
// never affect the AI call it is observing. Write failures are logged to stderr rather
// than swallowed silently.

import fsPromises from "node:fs/promises";
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

export async function writeAuditLogHeaderAsync(auditLogPath: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(auditLogPath), { recursive: true });
  await fsPromises.writeFile(auditLogPath, "");
}

export async function appendAuditLogLineAsync(
  auditLogPath: string,
  entry: AiAuditEntry,
): Promise<void> {
  await fsPromises.appendFile(auditLogPath, formatAuditEntryLine(entry));
}

function logAuditWriteFailure(error: unknown): void {
  // The audit log is a diagnostic side channel: a failed write must never crash the
  // process (no unhandled rejection) and must never propagate to the AI call it is
  // observing — but it must not vanish without a trace either, so it goes to stderr.
  console.error("[AiAuditLog] write failed", error);
}

const AUDIT_LOG_PATH = path.resolve(__dirname, "../../.cache/ai-audit.jsonl");

// Shared across all calls in this process so concurrent entries never race the
// truncate-once header write against each other. Reset to null on failure so the next
// entry retries initialization, mirroring the previous sync implementation's behaviour
// of retrying the header write on the next call after a throw.
let auditLogInitializationPromise: Promise<void> | null = null;

function ensureAuditLogInitializedAsync(auditLogPath: string): Promise<void> {
  if (!auditLogInitializationPromise) {
    auditLogInitializationPromise = writeAuditLogHeaderAsync(auditLogPath).catch((error) => {
      auditLogInitializationPromise = null;
      throw error;
    });
  }
  return auditLogInitializationPromise;
}

export function recordAiAuditEntry(entry: AiAuditEntry): void {
  // Fire-and-forget: intentionally not awaited by the caller (aiJSON in ai.ts). Any
  // rejection is caught here so it can never become an unhandled promise rejection or
  // affect the outcome of the AI call being audited.
  ensureAuditLogInitializedAsync(AUDIT_LOG_PATH)
    .then(() => appendAuditLogLineAsync(AUDIT_LOG_PATH, entry))
    .catch(logAuditWriteFailure);
}
