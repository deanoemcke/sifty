// Server-side only — process-level lock preventing overlapping scheduler runs
// from double-sending notifications for the same listing. Intended for use by
// the actual process entry point (scripts/scheduler.ts) only — runSchedulerAsync
// itself stays a plain reusable function with no filesystem side effects, so
// other callers (tests, future entry points) aren't gated by a lock file.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SCHEDULER_LOCK_PATH = path.resolve(__dirname, '../../.cache/scheduler.lock');

// A lock older than this is treated as stale regardless of whether its owning
// pid is still alive, so a wedged process (hung network call, deadlock, etc.)
// can't hold the lock forever and permanently disable future scheduler runs.
// Set generously above any expected single scheduler run.
export const LOCK_STALE_AGE_MS = 30 * 60 * 1000;

export type SchedulerLockResult = { acquired: true } | { acquired: false; reason: string };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no process with that pid — not alive. EPERM: it exists but we
    // lack permission to signal it — treat that as alive (can't tell).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockPid(lockPath: string): number | null {
  const contents = fs.readFileSync(lockPath, 'utf8').trim();
  const pid = Number(contents);
  return Number.isInteger(pid) ? pid : null;
}

function isLockStaleByAge(lockPath: string): boolean {
  const { mtimeMs } = fs.statSync(lockPath);
  return Date.now() - mtimeMs > LOCK_STALE_AGE_MS;
}

function removeStaleLockIfPresent(lockPath: string): void {
  if (!fs.existsSync(lockPath)) return;
  const pid = readLockPid(lockPath);
  if (pid !== null && isProcessAlive(pid) && !isLockStaleByAge(lockPath)) return;
  fs.unlinkSync(lockPath);
}

/**
 * Attempts to acquire the scheduler lock at `lockPath`, writing the current
 * process's pid into the file so a stale lock can be diagnosed. If a lock
 * file already exists for a pid that is no longer running, or the lock file
 * is older than `LOCK_STALE_AGE_MS` (even if its pid is still alive — e.g. a
 * wedged process), it is treated as stale, removed, and the lock is acquired.
 */
export function acquireSchedulerLock(lockPath: string): SchedulerLockResult {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  removeStaleLockIfPresent(lockPath);
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return { acquired: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { acquired: false, reason: `Lock file already held at ${lockPath}` };
    }
    throw err;
  }
}

/** Removes the lock file at `lockPath`, if present. Safe to call when it's already gone. */
export function releaseSchedulerLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
