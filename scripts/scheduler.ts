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
import { getDb } from '../src/server/db';
import { loadServerEnv } from '../src/server/env';
import { sendSignalNotificationAsync } from '../src/server/notify';
import { runSchedulerAsync } from '../src/server/scheduler';

loadServerEnv();

if (!process.env.OPENCLAW_BEARER_TOKEN) {
  console.error('OPENCLAW_BEARER_TOKEN environment variable is not set');
  process.exit(1);
}

async function main(): Promise<void> {
  const database = getDb();
  const cooldownStore = createProviderCooldownStore();

  const summary = await runSchedulerAsync({
    database,
    cooldownStore,
    sendNotificationAsync: sendSignalNotificationAsync,
  });

  let hadErrors = false;
  for (const search of summary.searches) {
    console.log(
      `[scheduler] ${search.savedSearchName}${search.isPopulationRun ? ' (population run)' : ''}: ` +
        `${search.listingsFoundCount} found, ${search.soldSkippedCount} sold, ` +
        `${search.aiFilteredOutCount} ai-filtered, ${search.alreadyAlertedCount} already alerted, ` +
        `${search.notifiedCount} notified, ${search.populatedCount} populated`
    );
    for (const error of search.errors) {
      hadErrors = true;
      console.error(`[scheduler] ${search.savedSearchName}: ${error}`);
    }
  }

  process.exit(hadErrors ? 1 : 0);
}

main().catch((err) => {
  console.error('[scheduler] fatal error:', (err as Error).message);
  process.exit(1);
});
