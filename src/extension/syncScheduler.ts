export type CookieSyncScheduler = {
  requestSync(): void;
};

// Facebook rotates several cookies together, firing a burst of change events:
// waiting until they stop means one sync reads the settled set instead of
// sending half-updated ones several times. Syncs never overlap, and a request
// that lands while one is running earns a follow-up, because that sync may
// already have read the old values.
export function createCookieSyncScheduler(options: {
  waitMs: number;
  syncAsync: () => Promise<void>;
  onSyncError: (error: unknown) => void;
}): CookieSyncScheduler {
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
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
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(onWaitElapsed, options.waitMs);
    },
  };
}
