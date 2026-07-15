// Server-side only — detailed audit trail for every request/response sent to the AI provider.
// The log file persists and is appended to across processes and runs — the scheduler
// (scripts/scheduler.ts) is a one-shot process invoked per cron tick, so truncating per
// process would wipe the trail down to a single run's entries every time. Each process
// only guarantees the containing directory exists once, mirroring db.ts's lazy getDb()
// singleton for that one-time setup step.
//
// All disk I/O here is async and fire-and-forget: recordAiAuditEntry() never blocks the
// event loop and never throws into its caller. This is a best-effort diagnostic side
// channel, not a transactional record — concurrent AI calls (see ConcurrencyQueue in
// src/lib/queue.ts) must never stall on audit-log disk writes, and a failing write must
// never affect the AI call it is observing. Write failures are logged to stderr rather
// than swallowed silently.
//
// Every field, including `systemMessage` and `userMessage` (the actual prompts sent to
// the AI provider), is logged in full and never truncated — this log is the diagnostic
// record of exactly what was sent and received, so a shortened prompt would defeat its
// purpose. A whole-file cap (MAX_AUDIT_LOG_FILE_SIZE_BYTES) rotates the file to a `.1`
// suffix (overwriting any previous rotation) once it grows past the threshold instead, so
// the file can't grow without bound across a long-running process.

import fsPromises from 'node:fs/promises';
import path from 'node:path';

export type AiAuditStatus =
  | 'success'
  | 'rate_limited'
  | 'http_error'
  | 'network_error'
  | 'parse_error'
  | 'budget_exceeded';

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

// Whole-file cap: once ai-audit.jsonl reaches this size, it is rotated to a `.1` suffix
// before the next line is appended. This is a diagnostic log, not a strict requirement,
// so a simple single-generation rotation (rather than numbered/dated log rotation) is
// the pragmatic choice — it bounds total disk usage to roughly 2x this threshold.
export const MAX_AUDIT_LOG_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export function formatAuditEntryLine(entry: AiAuditEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

export async function writeAuditLogHeaderAsync(auditLogPath: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(auditLogPath), { recursive: true });
  await fsPromises.writeFile(auditLogPath, '');
}

async function ensureAuditLogDirectoryAsync(auditLogPath: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(auditLogPath), { recursive: true });
}

async function getAuditLogFileSizeBytes(auditLogPath: string): Promise<number> {
  try {
    const stats = await fsPromises.stat(auditLogPath);
    return stats.size;
  } catch (error) {
    // A log file that hasn't been created yet is size zero, not a failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Rotates the audit log to a `.1` suffix (overwriting any previous rotation) once it
 * reaches maxSizeBytes. Renaming is an atomic filesystem operation, so a concurrent
 * appendAuditLogLineAsync call never observes a partially-rotated file. A missing file
 * is treated as size zero rather than an error.
 */
export async function rotateAuditLogIfOversizedAsync(
  auditLogPath: string,
  maxSizeBytes: number = MAX_AUDIT_LOG_FILE_SIZE_BYTES
): Promise<void> {
  const currentSizeBytes = await getAuditLogFileSizeBytes(auditLogPath);
  if (currentSizeBytes < maxSizeBytes) return;
  await fsPromises.rename(auditLogPath, `${auditLogPath}.1`);
}

export async function appendAuditLogLineAsync(
  auditLogPath: string,
  entry: AiAuditEntry,
  maxSizeBytes: number = MAX_AUDIT_LOG_FILE_SIZE_BYTES
): Promise<void> {
  await rotateAuditLogIfOversizedAsync(auditLogPath, maxSizeBytes);
  await fsPromises.appendFile(auditLogPath, formatAuditEntryLine(entry));
}

function logAuditWriteFailure(error: unknown): void {
  // The audit log is a diagnostic side channel: a failed write must never crash the
  // process (no unhandled rejection) and must never propagate to the AI call it is
  // observing — but it must not vanish without a trace either, so it goes to stderr.
  console.error('[AiAuditLog] write failed', error);
}

const AUDIT_LOG_PATH = path.resolve(__dirname, '../../data/ai-audit.jsonl');

// Shared across all calls in this process so concurrent entries never race the
// once-per-process directory creation against each other. Reset to null on failure so
// the next entry retries initialization.
let auditLogInitializationPromise: Promise<void> | null = null;

function ensureAuditLogInitializedAsync(auditLogPath: string): Promise<void> {
  if (!auditLogInitializationPromise) {
    auditLogInitializationPromise = ensureAuditLogDirectoryAsync(auditLogPath).catch((error) => {
      auditLogInitializationPromise = null;
      throw error;
    });
  }
  return auditLogInitializationPromise;
}

// Serializes every rotate-then-append sequence behind a single chained promise, the same
// pattern used above for auditLogInitializationPromise. Without this, two concurrent
// recordAiAuditEntry calls can both observe an oversized file in
// rotateAuditLogIfOversizedAsync's stat check and both attempt to rename it; the second
// rename throws ENOENT because the first already moved the file, silently dropping that
// entire entry. Chaining onto this promise makes rotate+append run one at a time, in
// order, while keeping recordAiAuditEntry itself fire-and-forget for its caller.
let pendingAuditWriteChain: Promise<void> = Promise.resolve();

export function recordAiAuditEntry(entry: AiAuditEntry): void {
  // Fire-and-forget: intentionally not awaited by the caller (aiJSON in ai.ts). Any
  // rejection is caught here so it can never become an unhandled promise rejection or
  // affect the outcome of the AI call being audited.
  pendingAuditWriteChain = pendingAuditWriteChain
    .then(() => ensureAuditLogInitializedAsync(AUDIT_LOG_PATH))
    .then(() => appendAuditLogLineAsync(AUDIT_LOG_PATH, entry))
    .catch(logAuditWriteFailure);
}
