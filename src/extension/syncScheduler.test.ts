import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCookieSyncScheduler } from './syncScheduler';

describe('createCookieSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not sync until the wait has passed', async () => {
    const syncAsync = vi.fn().mockResolvedValue(undefined);
    const scheduler = createCookieSyncScheduler({ waitMs: 5000, syncAsync, onSyncError: vi.fn() });

    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(4999);

    expect(syncAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(syncAsync).toHaveBeenCalledTimes(1);
  });

  it('turns a burst of requests into one sync, measured from the last request', async () => {
    const syncAsync = vi.fn().mockResolvedValue(undefined);
    const scheduler = createCookieSyncScheduler({ waitMs: 5000, syncAsync, onSyncError: vi.fn() });

    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(3000);
    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(3000);
    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(4999);
    expect(syncAsync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(syncAsync).toHaveBeenCalledTimes(1);
  });

  it('syncs again for a request made after an earlier sync finished', async () => {
    const syncAsync = vi.fn().mockResolvedValue(undefined);
    const scheduler = createCookieSyncScheduler({ waitMs: 1000, syncAsync, onSyncError: vi.fn() });

    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(1000);

    expect(syncAsync).toHaveBeenCalledTimes(2);
  });

  it('reports a failed sync and still syncs on a later request', async () => {
    const syncAsync = vi
      .fn()
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValue(undefined);
    const onSyncError = vi.fn();
    const scheduler = createCookieSyncScheduler({ waitMs: 1000, syncAsync, onSyncError });

    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSyncError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'host unavailable' })
    );

    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncAsync).toHaveBeenCalledTimes(2);
    expect(onSyncError).toHaveBeenCalledTimes(1);
  });

  it('runs one more sync after the current one when a request arrives mid-sync', async () => {
    let finishFirstSync: () => void = () => {};
    const syncAsync = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstSync = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const scheduler = createCookieSyncScheduler({ waitMs: 1000, syncAsync, onSyncError: vi.fn() });

    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncAsync).toHaveBeenCalledTimes(1);

    // The cookies change again while the first sync is still in flight: it may
    // have read the old values, so it must not be the last word.
    scheduler.requestSync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncAsync).toHaveBeenCalledTimes(1);

    finishFirstSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncAsync).toHaveBeenCalledTimes(2);
  });

  it('never runs two syncs at once', async () => {
    let activeSyncCount = 0;
    let maxActiveSyncCount = 0;
    const syncAsync = vi.fn(async () => {
      activeSyncCount++;
      maxActiveSyncCount = Math.max(maxActiveSyncCount, activeSyncCount);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      activeSyncCount--;
    });
    const scheduler = createCookieSyncScheduler({ waitMs: 1000, syncAsync, onSyncError: vi.fn() });

    for (let index = 0; index < 5; index++) {
      scheduler.requestSync();
      await vi.advanceTimersByTimeAsync(1500);
    }
    await vi.advanceTimersByTimeAsync(20_000);

    expect(maxActiveSyncCount).toBe(1);
  });
});
