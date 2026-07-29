/**
 * Headless saved-search alert scheduler — one pass over every saved search
 * with "alert on new listings" enabled, notifying via Signal for any new,
 * non-sold, non-filtered listing.
 *
 * Run with: npx tsx scripts/scheduler.ts (or npm run scheduler)
 * Intended to be invoked periodically by an external scheduler (cron/launchd) —
 * this script does a single pass and exits, it does not loop internally.
 */

import { createProviderCooldownStore } from '../src/server/ai';
import { closeAllPooledBrowsersAsync } from '../src/server/browserPool';
import { getDb } from '../src/server/db';
import { loadServerEnv } from '../src/server/env';
import { sendSignalNotificationAsync } from '../src/server/notify';
import { determineExitCode, runSchedulerAsync } from '../src/server/scheduler';
import {
  acquireSchedulerLock,
  DEFAULT_SCHEDULER_LOCK_PATH,
  releaseSchedulerLock,
} from '../src/server/schedulerLock';

loadServerEnv();

if (!process.env.OPENCLAW_BEARER_TOKEN) {
  console.error('OPENCLAW_BEARER_TOKEN environment variable is not set');
  // Exit 2, not 1: nothing could be attempted at all, distinct from "ran
  // fine but some searches had errors" (exit 1, alerted individually and
  // non-repetitively by the scheduler itself — see recordSavedSearchRunStatusAndAlertAsync
  // in scheduler.ts) — the wrapper script (run-and-notify.sh) only pages on
  // exit 2, so a per-tick per-search failure doesn't also trigger a second,
  // blunter "the whole scheduler is broken" alert.
  process.exit(2);
}

// Returns an exit code rather than calling process.exit() itself — process.exit()
// terminates the process immediately without running enclosing finally blocks,
// so the lock release below has to complete before anyone calls it.
async function main(): Promise<number> {
  const lockResult = acquireSchedulerLock(DEFAULT_SCHEDULER_LOCK_PATH);
  if (!lockResult.acquired) {
    console.error(`[scheduler] ${lockResult.reason} — another run is already in progress, skipping`);
    return 1;
  }

  try {
    const database = getDb();
    const cooldownStore = createProviderCooldownStore();

    const summary = await runSchedulerAsync({
      database,
      cooldownStore,
      sendNotificationAsync: sendSignalNotificationAsync,
    });

    for (const search of summary.searches) {
      console.log(
        `[scheduler] ${search.savedSearchName}${search.isPopulationRun ? ' (population run)' : ''}: ` +
          `${search.listingsFoundCount} found, ${search.soldSkippedCount} sold, ` +
          `${search.aiFilteredOutCount} ai-filtered, ${search.alreadyAlertedCount} already alerted, ` +
          `${search.notifiedCount} notified, ${search.populatedCount} populated`
      );
      for (const error of search.errors) {
        console.error(`[scheduler] ${search.savedSearchName}: ${error.message}`);
      }
    }

    const exitCode = determineExitCode(summary);
    if (exitCode === 2) {
      // Same exit code as the catastrophic "nothing could be attempted" case
      // above — the external wrapper only pages on exit 2, and this needs
      // that same external page precisely because it's a Signal delivery
      // outage: the scheduler's own Signal-based alerting can't report it.
      console.error(
        '[scheduler] notify delivery failed for multiple searches this tick — ' +
          'likely a systemic Signal/notification outage, not a per-listing blip'
      );
    }
    return exitCode;
  } finally {
    // runSchedulerAsync funnels through the facebook/trademe recipes, which check
    // out browsers from the shared pool in src/server/browserPool.ts — that pool
    // keeps a Chromium instance alive across calls rather than closing it per
    // request, so this one-shot script must close it explicitly before exiting
    // or it leaves an orphaned Chromium process behind every run.
    await closeAllPooledBrowsersAsync().catch((err) => {
      console.error('[scheduler] failed to close pooled browsers:', err);
    });
    releaseSchedulerLock(DEFAULT_SCHEDULER_LOCK_PATH);
  }
}

// main()'s own try/finally already releases the lock before this rejects,
// so no lock cleanup is needed here.
main()
  .then((exitCode) => process.exit(exitCode))
  .catch((err) => {
    console.error('[scheduler] fatal error:', (err as Error).message);
    // Exit 2 — see the OPENCLAW_BEARER_TOKEN check above for why this is 2, not 1.
    process.exit(2);
  });
