export type CookieSyncScheduler = {
  requestSync(): void;
};

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
