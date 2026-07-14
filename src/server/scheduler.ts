// Server-side only — headless scheduler core, invoked by scripts/scheduler.ts.
// Each run processes the single alert-enabled saved search that was run
// longest ago (or never run): its already-known URLs (no discovery, no deep
// search), applying its AI filter if set, and notifying on any new, non-sold
// listing it hasn't alerted on before.

import type Database from 'better-sqlite3';
import type { Listing, ProviderCooldownStore } from '../lib/recipes/base';
import {
  type SavedSearchRow,
  stmtCountAlertsForSavedSearch,
  stmtGetOldestAlertEnabledSavedSearch,
  stmtHasAlertedListing,
  stmtInsertAlertedListing,
  stmtUpdateSavedSearchLastRunAt,
} from './db';
import { getRecipeForUrl } from './recipes/registry';
import {
  type AiFilterListing,
  type FilterResultEntry,
  runAiFilterBatchesAsync,
} from './services/aiFilter';
import { runQuickSearchForUrlAsync } from './services/quickSearch';

// Upper bound on a single URL's quick search. The scheduler runs unattended
// via cron with no human to notice a hang — a stalled recipe (login wall,
// stuck socket, unresolved promise) must not be able to wedge the run
// forever and hold the scheduler lock indefinitely (see schedulerLock.ts).
export const SCRAPE_TIMEOUT_MS = 60_000;

// Upper bound on the whole AI-filter batch run for one saved search. Each
// underlying aiJSON call already has its own internal budget (ai.ts's
// TOTAL_TIMEOUT_MS), but batches run concurrently across multiple providers
// and retries, so this is a generous outer bound rather than a tight one.
export const AI_FILTER_TIMEOUT_MS = 120_000;

async function withTimeoutAsync<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export type SchedulerNotifier = (message: string) => Promise<void>;

export type SchedulerDeps = {
  database: Database.Database;
  cooldownStore: ProviderCooldownStore;
  sendNotificationAsync: SchedulerNotifier;
  now?: () => number;
};

export type SavedSearchRunSummary = {
  savedSearchId: string;
  savedSearchName: string;
  isPopulationRun: boolean;
  listingsFoundCount: number;
  soldSkippedCount: number;
  aiFilteredOutCount: number;
  alreadyAlertedCount: number;
  notifiedCount: number;
  populatedCount: number;
  errors: string[];
};

export type SchedulerSummary = {
  searches: SavedSearchRunSummary[];
};

export function formatAlertMessage(savedSearchName: string, listing: Listing): string {
  const price =
    listing.price === null || listing.price === undefined ? 'unknown price' : `$${listing.price}`;
  return `${savedSearchName}: ${listing.title} — ${price} — ${listing.url}`;
}

function toAiFilterListing(listing: Listing): AiFilterListing {
  return {
    url: listing.url,
    title: listing.title,
    price:
      listing.price === null || listing.price === undefined ? 'unknown' : String(listing.price),
    location: listing.location,
    description: listing.description ?? '',
  };
}

async function processSavedSearchAsync(
  row: SavedSearchRow,
  deps: Required<SchedulerDeps>
): Promise<SavedSearchRunSummary> {
  const { database, cooldownStore, sendNotificationAsync, now } = deps;
  const urls = JSON.parse(row.urls) as string[];
  const aiFilterPrompt = row.ai_filter?.trim() ? row.ai_filter : null;

  const summary: SavedSearchRunSummary = {
    savedSearchId: row.id,
    savedSearchName: row.name,
    // Captured once, up front, so it can't flip mid-run as rows get inserted below.
    isPopulationRun: stmtCountAlertsForSavedSearch(database).get(row.id)?.n === 0,
    listingsFoundCount: 0,
    soldSkippedCount: 0,
    aiFilteredOutCount: 0,
    alreadyAlertedCount: 0,
    notifiedCount: 0,
    populatedCount: 0,
    errors: [],
  };

  // Deduped by content hash, not URL — the same physical listing can appear
  // via more than one of this saved search's own URLs.
  const listingsByHash = new Map<string, Listing>();
  for (const url of urls) {
    const recipe = getRecipeForUrl(url);
    if (!recipe) {
      summary.errors.push(`No recipe found for URL: ${url}`);
      continue;
    }
    try {
      const { listings } = await withTimeoutAsync(
        runQuickSearchForUrlAsync(url, recipe, database, () => {}),
        SCRAPE_TIMEOUT_MS,
        `Quick search for ${url}`
      );
      for (const listing of listings)
        listingsByHash.set(recipe.computeAlertFingerprint(listing), listing);
    } catch (err) {
      summary.errors.push(`Quick search failed for ${url}: ${(err as Error).message}`);
    }
  }
  summary.listingsFoundCount = listingsByHash.size;

  let candidates = [...listingsByHash.entries()].filter(([, listing]) => !listing.isSold);
  summary.soldSkippedCount = listingsByHash.size - candidates.length;

  if (aiFilterPrompt && candidates.length > 0) {
    const aiFilterListings = candidates.map(([, listing]) => toAiFilterListing(listing));
    let results: FilterResultEntry[];
    try {
      results = await withTimeoutAsync(
        runAiFilterBatchesAsync(
          aiFilterListings,
          aiFilterPrompt,
          cooldownStore,
          undefined,
          (message) => summary.errors.push(`AI filter: ${message}`)
        ),
        AI_FILTER_TIMEOUT_MS,
        'AI filter batch run'
      );
    } catch (err) {
      // Mirrors the per-batch error path in runAiFilterBatchesAsync: none of
      // these candidates are treated as having passed, so nothing is
      // notified on unverified AI judgement rather than risking false alerts.
      summary.errors.push(`AI filter timed out: ${(err as Error).message}`);
      results = [];
    }
    const passedUrls = new Set(results.filter((result) => result.pass).map((result) => result.url));
    const beforeCount = candidates.length;
    candidates = candidates.filter(([, listing]) => passedUrls.has(listing.url));
    summary.aiFilteredOutCount = beforeCount - candidates.length;
  }

  for (const [hash, listing] of candidates) {
    if (stmtHasAlertedListing(database).get(row.id, hash)) {
      summary.alreadyAlertedCount++;
      continue;
    }
    if (summary.isPopulationRun) {
      stmtInsertAlertedListing(database).run(row.id, hash, now());
      summary.populatedCount++;
      continue;
    }
    try {
      await sendNotificationAsync(formatAlertMessage(row.name, listing));
      stmtInsertAlertedListing(database).run(row.id, hash, now());
      summary.notifiedCount++;
    } catch (err) {
      // Not recorded as alerted — retried on the next scheduler run.
      summary.errors.push(`Notification failed for ${listing.url}: ${(err as Error).message}`);
    }
  }

  return summary;
}

export async function runSchedulerAsync(deps: SchedulerDeps): Promise<SchedulerSummary> {
  const resolvedDeps: Required<SchedulerDeps> = { now: () => Date.now(), ...deps };
  const row = stmtGetOldestAlertEnabledSavedSearch(resolvedDeps.database).get();
  if (!row) return { searches: [] };

  let summary: SavedSearchRunSummary;
  try {
    summary = await processSavedSearchAsync(row, resolvedDeps);
  } catch (err) {
    // A synchronous throw (e.g. malformed row.urls JSON, SQLITE_BUSY) still
    // needs a result, and last_run_at below still needs to advance — otherwise
    // a permanently broken saved search would be picked as "oldest" forever
    // and starve every other alert-enabled saved search out of rotation.
    summary = {
      savedSearchId: row.id,
      savedSearchName: row.name,
      isPopulationRun: false,
      listingsFoundCount: 0,
      soldSkippedCount: 0,
      aiFilteredOutCount: 0,
      alreadyAlertedCount: 0,
      notifiedCount: 0,
      populatedCount: 0,
      errors: [`Unhandled error: ${(err as Error).message}`],
    };
  }
  stmtUpdateSavedSearchLastRunAt(resolvedDeps.database).run(resolvedDeps.now(), row.id);
  return { searches: [summary] };
}
