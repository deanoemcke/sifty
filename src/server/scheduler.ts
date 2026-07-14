// Server-side only — headless scheduler core, invoked by scripts/scheduler.ts.
// Runs every alert-enabled saved search's already-known URLs (no discovery,
// no deep search), applies its AI filter if set, and notifies on any new,
// non-sold listing it hasn't alerted on before.

import type Database from 'better-sqlite3';
import type { Listing, ProviderCooldownStore } from '../lib/recipes/base';
import { computeListingAlertHash } from './alerts';
import {
  type SavedSearchRow,
  stmtCountAlertsForSavedSearch,
  stmtHasAlertedListing,
  stmtInsertAlertedListing,
  stmtListAlertEnabledSavedSearches,
} from './db';
import { getRecipeForUrl } from './recipes/registry';
import { type AiFilterListing, runAiFilterBatchesAsync } from './routes/aiFilter';
import { runQuickSearchForUrlAsync } from './routes/quickSearch';

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
      const { listings } = await runQuickSearchForUrlAsync(url, recipe, database, () => {});
      for (const listing of listings) listingsByHash.set(computeListingAlertHash(listing), listing);
    } catch (err) {
      summary.errors.push(`Quick search failed for ${url}: ${(err as Error).message}`);
    }
  }
  summary.listingsFoundCount = listingsByHash.size;

  let candidates = [...listingsByHash.entries()].filter(([, listing]) => !listing.isSold);
  summary.soldSkippedCount = listingsByHash.size - candidates.length;

  if (aiFilterPrompt && candidates.length > 0) {
    const aiFilterListings = candidates.map(([, listing]) => toAiFilterListing(listing));
    const results = await runAiFilterBatchesAsync(
      aiFilterListings,
      aiFilterPrompt,
      cooldownStore,
      undefined,
      (message) => summary.errors.push(`AI filter: ${message}`)
    );
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
  const rows = stmtListAlertEnabledSavedSearches(resolvedDeps.database).all();

  const searches: SavedSearchRunSummary[] = [];
  // Sequential, not parallel — avoids hammering the shared Facebook session
  // and AI provider cooldowns across multiple saved searches at once.
  for (const row of rows) {
    searches.push(await processSavedSearchAsync(row, resolvedDeps));
  }
  return { searches };
}
