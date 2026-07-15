// Server-side only — headless scheduler core, invoked by scripts/scheduler.ts.
// Each run processes the single alert-enabled saved search that was run
// longest ago (or never run): its already-known URLs (no discovery, no deep
// search), applying its AI filter if set, and notifying on any new, non-sold
// listing it hasn't alerted on before.

import type Database from 'better-sqlite3';
import type { Listing, ProviderCooldownStore } from '../lib/recipes/base';
import {
  type SavedSearchRow,
  stmtGetOldestAlertEnabledSavedSearch,
  stmtHasAlertedListing,
  stmtInsertAlertedListing,
  stmtMarkPopulationRunComplete,
  stmtUpdateSavedSearchLastRunAt,
} from './db';
import { fetchListingImageAttachmentAsync } from './imageAttachment';
import type { SignalNotificationOptions } from './notify';
import { logQuickSearchEvent } from './quickSearchLogging';
import { getRecipeForUrl } from './recipes/registry';
import {
  type AiFilterListing,
  type FilterResultEntry,
  runAiFilterBatchesAsync,
} from './services/aiFilter';
import { runQuickSearchForUrlAsync } from './services/quickSearch';
import { formatAlertMessage } from './signalMessage';

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

// Upper bound on the whole per-listing notify loop for one saved search.
// Each thumbnail fetch and Signal POST already has its own internal timeout
// (imageAttachment.ts's IMAGE_FETCH_TIMEOUT_MS, notify.ts's NOTIFY_TIMEOUT_MS),
// but a saved search surfacing many new listings at once could still
// accumulate an unbounded total duration — this is a generous outer bound,
// mirroring SCRAPE_TIMEOUT_MS/AI_FILTER_TIMEOUT_MS above.
export const NOTIFY_LOOP_TIMEOUT_MS = 5 * 60_000;

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

export type SchedulerNotifier = (
  message: string,
  options?: SignalNotificationOptions
) => Promise<void>;

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

async function notifyNewListingsAsync(
  row: SavedSearchRow,
  candidates: [string, Listing][],
  deps: Required<SchedulerDeps>,
  summary: SavedSearchRunSummary
): Promise<void> {
  const { database, sendNotificationAsync, now } = deps;
  for (const [hash, listing] of candidates) {
    if (stmtHasAlertedListing(database).get(row.id, hash)) {
      summary.alreadyAlertedCount++;
      continue;
    }
    try {
      console.log(`[scheduler] "${row.name}": sending Signal notification for "${listing.title}"`);
      const image = await fetchListingImageAttachmentAsync(listing.thumbnailUrl);
      const message = formatAlertMessage(row.name, listing);
      try {
        await sendNotificationAsync(message, { image });
      } catch (err) {
        // A broken/oversized thumbnail must never sink the whole alert
        // (mirrors imageAttachment.ts's own stated invariant) — only retry
        // if an image was actually attached; retrying an already-imageless
        // call would just repeat the same failure.
        if (image === undefined) throw err;
        await sendNotificationAsync(message, {});
      }
      stmtInsertAlertedListing(database).run(row.id, hash, now());
      summary.notifiedCount++;
    } catch (err) {
      // Not recorded as alerted — retried on the next scheduler run.
      summary.errors.push(`Notification failed for ${listing.url}: ${(err as Error).message}`);
    }
  }
}

async function processSavedSearchAsync(
  row: SavedSearchRow,
  deps: Required<SchedulerDeps>
): Promise<SavedSearchRunSummary> {
  const { database, cooldownStore, now } = deps;
  const urls = JSON.parse(row.urls) as string[];
  const aiFilterPrompt = row.ai_filter?.trim() ? row.ai_filter : null;

  const summary: SavedSearchRunSummary = {
    savedSearchId: row.id,
    savedSearchName: row.name,
    // Read from the persisted flag rather than re-derived from
    // alerted_listings row counts: a run that legitimately inserts zero rows
    // (a recipe error, the AI filter rejecting every candidate, a transient
    // empty scrape) would otherwise leave the count at 0 forever, making the
    // *next* run — possibly the one that finds a genuine new listing —
    // misclassify itself as still-populating and silently swallow that
    // listing's alert instead of notifying.
    isPopulationRun: row.has_completed_population_run === 0,
    listingsFoundCount: 0,
    soldSkippedCount: 0,
    aiFilteredOutCount: 0,
    alreadyAlertedCount: 0,
    notifiedCount: 0,
    populatedCount: 0,
    errors: [],
  };

  console.log(
    `[scheduler] processing "${row.name}" (${urls.length} url(s))` +
      (summary.isPopulationRun ? ' — population run' : '')
  );

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
        runQuickSearchForUrlAsync(url, recipe, database, (event) =>
          logQuickSearchEvent(recipe.name, event)
        ),
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
  console.log(`[scheduler] "${row.name}": scraped ${summary.listingsFoundCount} listing(s)`);

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
    console.log(
      `[scheduler] "${row.name}": AI filter passed ${candidates.length}/${beforeCount} listing(s)`
    );
  }

  if (summary.isPopulationRun) {
    // The baseline insert and the "population run done" flag must land
    // together or not at all: if this were split across two statements, a
    // mid-run crash could commit some baseline rows and never set the flag
    // (next run redoes the notify-suppressed backfill — harmless), or set
    // the flag without a complete baseline (next run wrongly notifies on
    // pre-existing listings that were never actually recorded). Wrapping
    // both in one transaction makes a crash all-or-nothing: either the full
    // baseline plus the flag commit, or neither does and the next run
    // safely retries the whole population from scratch (stmtInsertAlertedListing
    // is INSERT OR IGNORE, so redoing it is idempotent).
    const insertPopulationBaseline = database.transaction((rows: [string, Listing][]) => {
      for (const [hash] of rows) stmtInsertAlertedListing(database).run(row.id, hash, now());
      stmtMarkPopulationRunComplete(database).run(row.id);
    });
    insertPopulationBaseline(candidates);
    summary.populatedCount = candidates.length;
    console.log(
      `[scheduler] "${row.name}": population run complete — recorded ${summary.populatedCount} baseline listing(s), no notifications sent`
    );
  } else {
    // Partial progress is preserved intentionally: stmtInsertAlertedListing
    // commits per-listing rather than in one wrapping transaction, so a
    // mid-loop timeout still leaves already-processed listings marked
    // alerted — only the unreached ones are retried on the next run.
    try {
      await withTimeoutAsync(
        notifyNewListingsAsync(row, candidates, deps, summary),
        NOTIFY_LOOP_TIMEOUT_MS,
        `Notify loop for "${row.name}"`
      );
    } catch (err) {
      summary.errors.push(`Notify loop timed out: ${(err as Error).message}`);
    }
    if (summary.notifiedCount === 0) {
      console.log(`[scheduler] "${row.name}": no new listings found`);
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
