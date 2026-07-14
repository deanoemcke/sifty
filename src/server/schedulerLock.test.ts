import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireSchedulerLock, LOCK_STALE_AGE_MS, releaseSchedulerLock } from './schedulerLock';

function tempLockPath(): string {
  return path.join(os.tmpdir(), `sifty-scheduler-lock-test-${Date.now()}-${Math.random()}.lock`);
}

describe('acquireSchedulerLock', () => {
  let lockPath: string;

  afterEach(() => {
    if (lockPath && fs.existsSync(lockPath)) fs.rmSync(lockPath);
  });

  it('acquires the lock and writes the current pid when no lock file exists', () => {
    lockPath = tempLockPath();

    const result = acquireSchedulerLock(lockPath);

    expect(result).toEqual({ acquired: true });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('creates the parent directory if it does not exist yet', () => {
    lockPath = path.join(
      os.tmpdir(),
      `sifty-scheduler-lock-test-dir-${Date.now()}`,
      'scheduler.lock'
    );

    const result = acquireSchedulerLock(lockPath);

    expect(result).toEqual({ acquired: true });
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.rmSync(path.dirname(lockPath), { recursive: true });
  });

  it('refuses to acquire when a lock file owned by a live process already exists', () => {
    lockPath = tempLockPath();
    // process.pid is always alive for the duration of this test process.
    fs.writeFileSync(lockPath, String(process.pid));

    const result = acquireSchedulerLock(lockPath);

    expect(result.acquired).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('treats a lock file for a pid that is no longer running as stale, removes it, and acquires the lock', () => {
    lockPath = tempLockPath();
    // A pid essentially guaranteed not to be alive.
    const deadPid = 999999;
    fs.writeFileSync(lockPath, String(deadPid));

    const result = acquireSchedulerLock(lockPath);

    expect(result).toEqual({ acquired: true });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('treats an unparseable lock file as stale, removes it, and acquires the lock', () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, 'not-a-pid');

    const result = acquireSchedulerLock(lockPath);

    expect(result).toEqual({ acquired: true });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('treats an empty lock file (which parses as pid 0) as stale, removes it, and acquires the lock', () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, '');

    const result = acquireSchedulerLock(lockPath);

    expect(result).toEqual({ acquired: true });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('treats a lock file containing "0" as stale, removes it, and acquires the lock', () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, '0');

    const result = acquireSchedulerLock(lockPath);

    expect(result).toEqual({ acquired: true });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('treats a lock file held by a live process as stale once it exceeds the max age, removes it, and acquires the lock', () => {
    lockPath = tempLockPath();
    // process.pid is alive for the duration of this test, so liveness alone
    // would never let this lock be reclaimed — only its age should.
    fs.writeFileSync(lockPath, String(process.pid));
    const longAgo = Date.now() - (LOCK_STALE_AGE_MS + 60_000);
    fs.utimesSync(lockPath, longAgo / 1000, longAgo / 1000);

    const result = acquireSchedulerLock(lockPath);

    expect(result).toEqual({ acquired: true });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('does not treat a lock file held by a live process as stale while within the max age', () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, String(process.pid));
    const recently = Date.now() - 1000;
    fs.utimesSync(lockPath, recently / 1000, recently / 1000);

    const result = acquireSchedulerLock(lockPath);

    expect(result.acquired).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });
});

describe('releaseSchedulerLock', () => {
  let lockPath: string;

  afterEach(() => {
    if (lockPath && fs.existsSync(lockPath)) fs.rmSync(lockPath);
  });

  it('removes an existing lock file', () => {
    lockPath = tempLockPath();
    fs.writeFileSync(lockPath, String(process.pid));

    releaseSchedulerLock(lockPath);

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not throw when the lock file does not exist', () => {
    lockPath = tempLockPath();

    expect(() => releaseSchedulerLock(lockPath)).not.toThrow();
  });
});
