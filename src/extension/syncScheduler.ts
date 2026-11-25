export type CookieSyncScheduler = {
  requestSync(): void;
};

// Facebook rotates several cookies together, firing a burst of change events:
// waiting until they stop means one sync reads the settled set instead of
// sending half-updated ones several times. Syncs never overlap, and a request
// that lands while one is running earns a follow-up, because that sync may
// already have read the old values. The wait is capped at maxWaitMs from the
// first request of a burst, so cookies that never stop changing cannot postpone
// syncing indefinitely.
export function createCookieSyncScheduler(options: {
  waitMs: number;
  maxWaitMs: number;
  syncAsync: () => Promise<void>;
  onSyncError: (error: unknown) => void;
}): CookieSyncScheduler {
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let burstStartedAtMs = 0;
  let isSyncing = false;
  let isFollowUpSyncNeeded = false;

  async function runSyncsAsync(): Promise<void> {
    isSyncing = true;
    do {
      isFollowUpSyncNeeded = false;
      try {
        await options.syncAsync();
      } catch (error) {
        options.onSyncError(error);
      }
    } while (isFollowUpSyncNeeded);
    isSyncing = false;
  }

  function onWaitElapsed(): void {
    pendingTimer = undefined;
    if (isSyncing) {
      isFollowUpSyncNeeded = true;
      return;
    }
    void runSyncsAsync();
  }

  return {
    requestSync() {
      const nowMs = Date.now();
      if (pendingTimer === undefined) {
        burstStartedAtMs = nowMs;
      } else {
        clearTimeout(pendingTimer);
      }
      const remainingMaxWaitMs = burstStartedAtMs + options.maxWaitMs - nowMs;
      pendingTimer = setTimeout(onWaitElapsed, Math.min(options.waitMs, remainingMaxWaitMs));
    },
  };
}
