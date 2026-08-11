// Server-side only — headless scheduler core, invoked by scripts/scheduler.ts.
// Each run processes every alert-enabled saved search that is "due" — never
// run, or last run at or before TARGET_INTERVAL_MINUTES ago — oldest first,
// capped at MAX_SEARCHES_PER_TICK. For each: its already-known URLs (no
// discovery, no deep search), applying its AI filter if set, and notifying
// on any new, non-sold listing it hasn't alerted on before.

import type Database from 'better-sqlite3';
import type { Listing, ProviderCooldownStore } from '../lib/recipes/base';
import { checkInternetConnectivityAsync } from './connectivity';
import {
  type SavedSearchRow,
  stmtClearAlertSetupNotificationPending,
  stmtCountDueAlertEnabledSavedSearches,
  stmtGetDueAlertEnabledSavedSearches,
  stmtGetSavedSearch,
  stmtGetSitewideAlertState,
  stmtHasAlertedListing,
  stmtInsertAlertedListing,
  stmtMarkAlertSetupNotificationPending,
  stmtMarkPopulationRunComplete,
  stmtUpdateSavedSearchLastRunAt,
  stmtUpdateSavedSearchRunStatus,
  stmtUpsertSitewideAlertState,
} from './db';
import { fetchListingImageAttachmentAsync } from './imageAttachment';
import { type SignalNotificationOptions, sendSignalNotificationAsync } from './notify';
import { logQuickSearchEvent } from './quickSearchLogging';
import { LOGIN_REQUIRED_MESSAGE } from './recipes/facebook';
import { getRecipeForUrl } from './recipes/registry';
import { normalizeScrapeErrorReason } from './schedulerErrorText';
import {
  acquireSchedulerLock,
  DEFAULT_SCHEDULER_LOCK_PATH,
  releaseSchedulerLock,
} from './schedulerLock';
import {
  type AiFilterListing,
  type FilterResultEntry,
  runAiFilterBatchesAsync,
} from './services/aiFilter';
import { runQuickSearchForUrlAsync } from './services/quickSearch';
import {
  formatAlertMessage,
  formatAlertSetupFailedMessage,
  formatAlertSetupSuccessMessage,
  formatFacebookCookiesFailingMessage,
  formatFacebookCookiesRecoveredMessage,
  formatNetworkUnreachableFailingMessage,
  formatNetworkUnreachableRecoveredMessage,
  formatSearchFailingMessage,
  formatSearchRecoveredMessage,
} from './signalMessage';

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

// Upper bound on the single Signal send in recordSavedSearchRunStatusAndAlertAsync.
// Unlike the per-listing sends inside notifyNewListingsAsync (bounded only by
// the enclosing NOTIFY_LOOP_TIMEOUT_MS), this call isn't nested inside any
// other timeout — without its own bound, an unresponsive notifier here would
// wedge runOneSavedSearchAsync indefinitely, the exact failure mode
// SCRAPE_TIMEOUT_MS/AI_FILTER_TIMEOUT_MS/NOTIFY_LOOP_TIMEOUT_MS all exist to
// prevent elsewhere in this file. Generous relative to notify.ts's own
// internal 10s bound, same rationale as those three.
export const STATUS_ALERT_TIMEOUT_MS = 30_000;

// The guarantee: no alert-enabled saved search should go longer than this
// between runs. Only holds if the external tick interval (launchd's
// StartInterval in ai.openclaw.sifty-scheduler.plist, currently 1800s/30min)
// stays well below it — nothing keeps that plist value and this constant in
// sync automatically.
export const TARGET_INTERVAL_MINUTES = 240;

// Cap on how many due searches to process in a single tick, so a large
// backlog (e.g. many searches added at once) can't turn one tick into an
// unbounded scraping burst. A backlog beyond this cap is processed over
// subsequent ticks — oldest (most overdue) searches sort first, so it
// self-heals rather than starving anything indefinitely.
export const MAX_SEARCHES_PER_TICK = 5;

// Once a saved search is failing and has already been alerted on, how long
// before the *same* underlying failure is re-alerted anyway (see
// recordSavedSearchRunStatusAndAlertAsync below) — so a persistent problem
// doesn't go silent forever between the initial alert and its eventual fix,
// while still not re-sending every single tick.
export const FAILURE_REALERT_MS = 12 * 60 * 60 * 1000;

// Builds an order-independent comparison key from a run's individual errors,
// for the "is this the same failure as last run" check in
// recordSavedSearchRunStatusAndAlertAsync below. AI-filter batches complete
// concurrently (see runAiFilterBatchesAsync's ConcurrencyQueue), so the same
// underlying set of failures can land in summary.errors in a different order
// on two consecutive runs — comparing normalized, deduped, sorted
// `kind:message` pairs (rather than one order-sensitive joined blob) keeps
// the 12h re-alert suppression working regardless of that ordering.
//
// `kind` is included alongside `message`, not just `message` alone: this PR's
// per-line categorization tags each failure with a subsystem/severity (see
// categorizedErrorLine in signalMessage.ts), and a failure that escalates —
// e.g. the same recurring error text reclassified from a minor subsystem to
// 'unhandled' — is exactly the kind of change worth breaking the re-alert
// suppression for. Comparing on message alone would let that escalation hide
// behind unchanged message text and never re-alert. `kind` is typed as
// `string` rather than `SchedulerErrorKind` here so the same function can
// compare live SchedulerError values against parseStoredFailureDetail's
// output below, which — for last_run_detail rows that predate this
// kind-tagged format — deliberately produces a kind outside that union (see
// LEGACY_DETAIL_KIND) rather than crashing or guessing.
export function buildFailureComparisonKey(errors: { kind: string; message: string }[]): string {
  return [
    ...new Set(errors.map((error) => `${error.kind}:${normalizeScrapeErrorReason(error.message)}`)),
  ]
    .sort()
    .join('\n');
}

// Sentinel kind assigned to a last_run_detail line that can't be attributed
// to a real SchedulerErrorKind — either because it predates this format
// (rows written before this PR stored bare message text, with no kind at
// all) or because the tag doesn't match one of KNOWN_SCHEDULER_ERROR_KINDS.
// Deliberately not a valid SchedulerErrorKind value, so it can never
// coincidentally equal a real run's kind and wrongly confirm a "same
// failure" match — the worst case is one extra, harmless re-alert right
// after this format change ships, never a crash and never a wrongly
// suppressed alert for data this code can't fully interpret.
const LEGACY_DETAIL_KIND = 'legacy-unknown';

const KNOWN_SCHEDULER_ERROR_KINDS: readonly SchedulerErrorKind[] = [
  'scrape',
  'ai-filter',
  'notify',
  'unhandled',
];

// Parses one line of a persisted last_run_detail value (see
// recordSavedSearchRunStatusAndAlertAsync below, which writes each health
// error as `${kind}:${message}`) back into a kind/message pair for
// buildFailureComparisonKey. Only trusts the text before the first `:` as a
// kind when it's one of the real SchedulerErrorKind values — anything else
// (including bare pre-kind-tagging message text, which often contains its
// own `:`, e.g. "Quick search failed for <url>: <reason>") falls back to
// LEGACY_DETAIL_KIND with the line kept whole as the message.
function parseStoredFailureDetailLine(line: string): { kind: string; message: string } {
  const separatorIndex = line.indexOf(':');
  if (separatorIndex !== -1) {
    const candidateKind = line.slice(0, separatorIndex);
    if (KNOWN_SCHEDULER_ERROR_KINDS.includes(candidateKind as SchedulerErrorKind)) {
      return { kind: candidateKind, message: line.slice(separatorIndex + 1) };
    }
  }
  return { kind: LEGACY_DETAIL_KIND, message: line };
}

// Splits a persisted last_run_detail value back into per-error kind/message
// pairs for the "same failure as last run" comparison in
// recordSavedSearchRunStatusAndAlertAsync below.
function parseStoredFailureDetail(detail: string | null): { kind: string; message: string }[] {
  return (detail ?? '').split('\n').filter(Boolean).map(parseStoredFailureDetailLine);
}

// Bound on a captured scrape-failure reason's length, applied at the point
// the raw text is captured — before it flows into summary.errors (and from
// there into last_run_detail and the outbound Signal alert,
// formatSearchFailingMessage) — so an unusually long or malformed error
// can't grow unbounded downstream. Matches the existing 200-char precedent
// for AI parse-error messages in ai.ts.
export const SCRAPE_ERROR_REASON_MAX_LENGTH = 200;

// Caught/emitted errors from a real page.goto failure (Playwright) are often
// multi-line: an informative first line, then a verbose "Call log" trailer,
// and that first line often ends with "at <url>". Alerts are meant to read
// as "which search, what went wrong" — the specific URL isn't actionable
// from a phone notification, and once multiple URLs fail identically they'd
// otherwise show whichever one happened to survive dedupeErrors' collapse,
// which reads as "only this one URL failed" even when the whole search did.
// Stripped here, at capture, rather than only at display time, so
// last_run_detail and the outbound alert always show the same clean text.
function sanitizeScrapeReason(raw: string): string {
  return raw
    .split('\n')[0]
    .replace(/\s+at\s+https?:\/\/\S+/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, SCRAPE_ERROR_REASON_MAX_LENGTH);
}

// Bound on the *aggregated* failure text — summary.errors joined together —
// applied in recordSavedSearchRunStatusAndAlertAsync just before it reaches
// last_run_detail or the outbound Signal alert. Unlike
// SCRAPE_ERROR_REASON_MAX_LENGTH above, this isn't applied at each individual
// summary.errors.push() call site (notification-send failures and AI-filter
// error messages aren't capped there), so without this second, coarser bound
// the aggregate could still grow unbounded even though each scrape-failure
// reason on its own is already bounded. Sized as a multiple of
// SCRAPE_ERROR_REASON_MAX_LENGTH so a run with several already-capped
// scrape-failure reasons still fits, rather than being an independent value
// to keep in sync by hand.
export const AGGREGATED_FAILURE_DETAIL_MAX_LENGTH = SCRAPE_ERROR_REASON_MAX_LENGTH * 10;

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
  targetIntervalMs?: number;
  maxSearchesPerTick?: number;
  checkConnectivityAsync?: () => Promise<boolean>;
};

// 'notify' covers both per-listing alert sends (notifyNewListingsAsync) and
// the status alert send itself (sendAlertSafelyAsync) — both are Signal
// delivery failures, not evidence the saved search's own scrape/filter is
// broken, so recordSavedSearchRunStatusAndAlertAsync below excludes this kind
// from its health/alerting decision.
export type SchedulerErrorKind = 'scrape' | 'ai-filter' | 'notify' | 'unhandled';

export type SchedulerError = {
  kind: SchedulerErrorKind;
  message: string;
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
  errors: SchedulerError[];
  // Which recipe(s) this run actually invoked, regardless of outcome — used
  // by reconcileSitewideAlertAsync to tell "this search succeeded because it
  // doesn't use Facebook at all" apart from "this search succeeded and its
  // success is real evidence Facebook is working".
  touchedRecipeNames: Set<string>;
  // Whether this run's own connectivity check (see processSavedSearchAsync)
  // found the network reachable — undefined when the run never got that far
  // (e.g. a synchronous throw before the check, see runOneSavedSearchAsync's
  // catch block), which reconcileSitewideAlertAsync must not mistake for
  // "connectivity is fine": only a run that actually checked is evidence.
  wasOnline?: boolean;
};

// The two recognized application-wide failure causes today — see
// reconcileSitewideAlertAsync below. Not a generic multi-cause registry: the
// table they're persisted in (sitewide_alert_state) is cause-keyed so a
// third cause wouldn't need a schema change, but the detection/formatting
// code stays specific to each cause rather than a pluggable framework.
export const FACEBOOK_COOKIES_CAUSE = 'facebook-cookies';
export const NETWORK_UNREACHABLE_CAUSE = 'network-unreachable';

// Shared with the error-push site in processSavedSearchAsync below, so
// isNetworkUnreachableFailure can recognize it without duplicating the string.
const NETWORK_UNREACHABLE_MESSAGE = 'Network unreachable — skipped this run';

// Typed against the same widened { kind: string; message: string } shape as
// buildFailureComparisonKey above, not SchedulerError itself, so it can be
// applied to both live SchedulerError values and parseStoredFailureDetail's
// output (persisted failure lines, parsed back with a string kind).
function isFacebookCookieFailure(error: { kind: string; message: string }): boolean {
  return error.kind === 'scrape' && error.message.includes(LOGIN_REQUIRED_MESSAGE);
}

function isNetworkUnreachableFailure(error: { kind: string; message: string }): boolean {
  return error.kind === 'scrape' && error.message === NETWORK_UNREACHABLE_MESSAGE;
}

// Any error already covered by one of the sitewide alerts above — used to
// keep a per-search alert from repeating a line the sitewide alert already
// sent, and to recognize when a search's *entire* previous failure was
// sitewide-covered (so its own recovery ping can be suppressed too).
function isSitewideCoveredFailure(error: { kind: string; message: string }): boolean {
  return isFacebookCookieFailure(error) || isNetworkUnreachableFailure(error);
}

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
    category: listing.categoryPath,
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
      const message = formatAlertMessage(listing);
      // Sent as two separate messages, not one combined image+caption send:
      // the Signal client renders a combined send's caption at the width of
      // a fixed, cropped image thumbnail box rather than the chat's full
      // bubble width, which visibly cramps the caption regardless of its
      // own length. A broken/oversized thumbnail must never sink the whole
      // alert (mirrors imageAttachment.ts's own stated invariant), so a
      // failed image send is swallowed — only the text message is required.
      if (image !== undefined) {
        try {
          await sendNotificationAsync('', { image });
        } catch (err) {
          console.warn(
            `[scheduler] image notification failed for ${listing.url}: ${(err as Error).message}`
          );
        }
      }
      await sendNotificationAsync(message);
      stmtInsertAlertedListing(database).run(row.id, hash, now());
      summary.notifiedCount++;
    } catch (err) {
      // Not recorded as alerted — retried on the next scheduler run.
      summary.errors.push({
        kind: 'notify',
        message: `Notification failed for ${listing.url}: ${(err as Error).message}`,
      });
    }
  }
}

// row.urls is external/untrusted data at this boundary — it can be corrupted
// by a direct DB edit outside the app's control. Name the search and state
// what's wrong rather than letting a raw JSON.parse error (or a silently
// wrong-shaped value) reach the Signal alert unexplained.
function parseSavedSearchUrls(row: SavedSearchRow): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.urls);
  } catch (err) {
    throw new Error(
      `Corrupted saved search "${row.name}": urls column is not valid JSON (${(err as Error).message})`
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((url) => typeof url === 'string')) {
    throw new Error(
      `Corrupted saved search "${row.name}": urls column did not parse to an array of strings`
    );
  }
  return parsed;
}

async function processSavedSearchAsync(
  row: SavedSearchRow,
  deps: Required<SchedulerDeps>
): Promise<SavedSearchRunSummary> {
  const { database, cooldownStore, now, checkConnectivityAsync } = deps;
  const urls = parseSavedSearchUrls(row);
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
    touchedRecipeNames: new Set(),
  };

  console.log(
    `[scheduler] processing "${row.name}" (${urls.length} url(s))` +
      (summary.isPopulationRun ? ' — population run' : '')
  );

  // Deduped by content hash, not URL — the same physical listing can appear
  // via more than one of this saved search's own URLs.
  const listingsByHash = new Map<string, Listing>();
  // Populated by any recipe whose scrape didn't reach a trustworthy
  // completion this run (see the `didCompleteSuccessfully` check below) —
  // used below to decide whether a population run can safely complete this
  // tick. The individual reasons also land in summary.errors, which is what
  // recordSavedSearchRunStatusAndAlertAsync (below) alerts on.
  const scrapeFailureReasons: string[] = [];
  // Checked once, up front, rather than letting every URL below fail
  // independently for the identical reason — a total outage would otherwise
  // burn a full SCRAPE_TIMEOUT_MS per URL only to arrive at the same
  // "network unreachable" conclusion N times over.
  const isOnline = await checkConnectivityAsync();
  summary.wasOnline = isOnline;
  if (!isOnline) {
    console.warn(`[scheduler] "${row.name}": skipping — no internet connectivity`);
    summary.errors.push({ kind: 'scrape', message: NETWORK_UNREACHABLE_MESSAGE });
    scrapeFailureReasons.push(NETWORK_UNREACHABLE_MESSAGE);
  } else {
    for (const url of urls) {
      const recipe = getRecipeForUrl(url);
      if (!recipe) {
        summary.errors.push({ kind: 'scrape', message: 'No recipe found for this URL' });
        continue;
      }
      summary.touchedRecipeNames.add(recipe.name);
      let latestErrorMessage: string | undefined;
      try {
        const { listings, didCompleteSuccessfully } = await withTimeoutAsync(
          runQuickSearchForUrlAsync(url, recipe, database, (event) => {
            if (event.type === 'error') latestErrorMessage = event.message;
            logQuickSearchEvent(recipe.name, event);
          }),
          SCRAPE_TIMEOUT_MS,
          `Quick search for ${url}`
        );
        if (!didCompleteSuccessfully) {
          // A recipe that returns without ever reaching `{type:'complete'}` (a
          // login wall, a block, a mid-scrape failure) may still have pushed
          // some `listing` events before it detected the failure — e.g.
          // facebook.ts's detectLoginWallAsync fires only after already-
          // rendered DOM listings have been processed by the MutationObserver
          // injection. Those listings are not trustworthy and must never reach
          // AI filtering or notification.
          const reason = sanitizeScrapeReason(
            latestErrorMessage ?? 'did not complete successfully'
          );
          summary.errors.push({
            kind: 'scrape',
            message: `Discarded ${listings.length} untrusted listing(s): ${reason}`,
          });
          scrapeFailureReasons.push(reason);
          continue;
        }
        for (const listing of listings)
          listingsByHash.set(recipe.computeAlertFingerprint(listing), listing);
      } catch (err) {
        const reason = sanitizeScrapeReason((err as Error).message);
        summary.errors.push({
          kind: 'scrape',
          message: `Quick search failed: ${reason}`,
        });
        scrapeFailureReasons.push(reason);
      }
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
          (message) => summary.errors.push({ kind: 'ai-filter', message: `AI filter: ${message}` })
        ),
        AI_FILTER_TIMEOUT_MS,
        'AI filter batch run'
      );
    } catch (err) {
      // Mirrors the per-batch error path in runAiFilterBatchesAsync: none of
      // these candidates are treated as having passed, so nothing is
      // notified on unverified AI judgement rather than risking false alerts.
      summary.errors.push({
        kind: 'ai-filter',
        message: `AI filter timed out: ${(err as Error).message}`,
      });
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
    if (scrapeFailureReasons.length > 0) {
      // At least one of this search's URLs never reached a trustworthy
      // completion this run (see the didCompleteSuccessfully check above),
      // so `candidates` is missing that URL's listings entirely. Leaving
      // has_completed_population_run unset means the whole search retries
      // as a population run next tick instead of silently baselining only
      // the URLs that happened to succeed — otherwise, the next time the
      // failed URL succeeds, every listing on it would look "new" (never
      // baselined) and flood out as individual notifications.
      summary.errors.push({
        kind: 'scrape',
        message: `Population run incomplete — ${scrapeFailureReasons.length} URL(s) failed; retrying full baseline next run`,
      });
      console.log(
        `[scheduler] "${row.name}": population run incomplete — ${scrapeFailureReasons.length} URL(s) failed, retrying next tick`
      );
    } else {
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
    }
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
      summary.errors.push({
        kind: 'notify',
        message: `Notify loop timed out: ${(err as Error).message}`,
      });
    }
    if (summary.notifiedCount === 0) {
      console.log(`[scheduler] "${row.name}": no new listings found`);
    }
  }

  return summary;
}

// Sends a Signal alert and swallows any failure into summary.errors instead
// of letting it propagate — mirrors the per-listing pattern in
// notifyNewListingsAsync above. Called after `succeeded`/`detail` are already
// decided, so a failed send here can't retroactively change what this run's
// outcome was, only whether the exit code (via summary.errors) reflects that
// the alert itself didn't go out.
async function sendAlertSafelyAsync(
  message: string,
  summary: SavedSearchRunSummary,
  deps: Required<SchedulerDeps>
): Promise<void> {
  try {
    await withTimeoutAsync(
      deps.sendNotificationAsync(message),
      STATUS_ALERT_TIMEOUT_MS,
      'Status alert notification'
    );
  } catch (err) {
    summary.errors.push({
      kind: 'notify',
      message: `Status notification failed: ${(err as Error).message}`,
    });
  }
}

// Shared by reconcileSitewideAlertAsync and
// recordSavedSearchRunStatusAndAlertAsync — both re-alert a standing failure
// only after FAILURE_REALERT_MS has passed since it was last alerted, so a
// persisting issue doesn't go silent indefinitely without paging on every run.
function isWithinReAlertWindow(
  isConditionActive: boolean,
  lastAlertedAt: number | null,
  now: number
): boolean {
  return isConditionActive && lastAlertedAt != null && now - lastAlertedAt < FAILURE_REALERT_MS;
}

// Coordinates a single, shared application-wide alert (one per `cause`)
// across every saved search a failure of that cause could affect, using the
// sitewide_alert_state row for that cause as the coordination point.
// runSchedulerAsync processes due searches strictly sequentially (no
// concurrency), so this row is a safe single source of truth: the first
// failing search in a tick (or a later tick, since the row persists)
// flips/confirms it active and sends; every other affected search — same
// tick or a later one, within FAILURE_REALERT_MS — sees it already active
// and sends nothing. Same symmetry for recovery.
//
// `hasHealthEvidence` (not just "no failure now") is what makes a success
// count as real recovery evidence — a search this cause couldn't possibly
// have affected (e.g. one that never uses Facebook) trivially has no
// failure of that cause every run, and must never be mistaken for proof the
// cause has cleared. Callers pass true only when this run's own outcome
// actually speaks to the cause's current state one way or the other.
async function reconcileSitewideAlertAsync(
  cause: string,
  hasFailureNow: boolean,
  hasHealthEvidence: boolean,
  formatFailingMessage: () => string,
  formatRecoveredMessage: () => string,
  summary: SavedSearchRunSummary,
  deps: Required<SchedulerDeps>
): Promise<void> {
  if (!hasFailureNow && !hasHealthEvidence) return;

  const state = stmtGetSitewideAlertState(deps.database).get(cause);
  const isCurrentlyActive = state?.is_active === 1;

  if (hasFailureNow) {
    if (isWithinReAlertWindow(isCurrentlyActive, state?.last_alerted_at ?? null, deps.now())) {
      return;
    }
    await sendAlertSafelyAsync(formatFailingMessage(), summary, deps);
    stmtUpsertSitewideAlertState(deps.database).run(cause, 1, deps.now());
    return;
  }

  if (isCurrentlyActive) {
    await sendAlertSafelyAsync(formatRecoveredMessage(), summary, deps);
    stmtUpsertSitewideAlertState(deps.database).run(cause, 0, null);
  }
}

// Single choke point for "did this saved search's run succeed or fail, and
// does that change from last time warrant a Signal alert" — covers every
// failure mode processSavedSearchAsync can produce, plus the catch-all
// "Unhandled error" case, since both flow through the same `summary` shape
// by the time this runs. Alerts only on the success→failure and
// failure→success edges, with one exception: the *same* normalized failure
// persisting re-alerts after FAILURE_REALERT_MS so a standing issue doesn't
// go silent indefinitely between the initial alert and its eventual fix.
//
// `isImmediateSetupRun` marks the one other case that always alerts on
// success too: the immediate population run triggered by turning a saved
// search's alert checkbox on (or editing an already alert-on search) — see
// runImmediatePopulationRunAsync below. Regular scheduler ticks leave this
// false, so a saved search's *first* (silent) population run via the normal
// cron rotation still doesn't notify — only the user-triggered "set up my
// alert" moment does.
//
// `row.alert_setup_notification_pending` covers the case where that
// user-triggered moment couldn't run at all: runImmediatePopulationRunAsync
// only gets one lock-acquisition attempt, and if a real cron tick already
// holds the lock it defers and never runs again — isImmediateSetupRun is
// never set for the row again either. stmtMarkAlertSetupNotificationPending
// carries the "this row still owes the user a setup confirmation" intent
// forward onto the DB row itself, so whichever run eventually processes this
// saved search next — a deferred retry or an ordinary due-search tick —
// still counts as the setup moment, *provided that run is itself still a
// population run*: the pending flag can outlive that guarantee (e.g. a cron
// tick fetched the row just before the flag was written, missed it, and
// completed the population run anyway — the next tick to see the flag is
// then an ordinary post-population run, not a genuine setup moment), so
// isSetupMoment below also requires summary.isPopulationRun. Consumed
// (cleared) here the moment the flag is read, regardless of that check, so a
// later run can't see the same flag and resend the confirmation.
async function recordSavedSearchRunStatusAndAlertAsync(
  row: SavedSearchRow,
  summary: SavedSearchRunSummary,
  deps: Required<SchedulerDeps>,
  options: { isImmediateSetupRun?: boolean } = {}
): Promise<void> {
  // Both success and failure below key off this single flag so they can
  // never disagree — see the comment above this function for why the pending
  // flag alone isn't enough: it can still be true on a row whose population
  // run already completed (e.g. a cron tick fetched the row just before the
  // flag was written, missed it, and the next tick to consume it is an
  // ordinary post-population run) so isSetupMoment also requires
  // summary.isPopulationRun, matching the guarantee that holds at both of
  // runImmediatePopulationRunAsync's own call sites.
  const isSetupMoment =
    (options.isImmediateSetupRun === true || row.alert_setup_notification_pending === 1) &&
    summary.isPopulationRun;
  if (row.alert_setup_notification_pending === 1) {
    stmtClearAlertSetupNotificationPending(deps.database).run(row.id);
  }

  // Notify-kind errors (a flaky Signal send) are excluded from health: they
  // mean delivery hiccuped, not that this saved search's scrape/filter is
  // broken, and are already retried next run without needing a failure
  // alert of their own (see notifyNewListingsAsync/sendAlertSafelyAsync).
  const healthErrors = summary.errors.filter((error) => error.kind !== 'notify');
  const succeeded = healthErrors.length === 0;
  // Persists `kind` alongside `message` per line (parsed back by
  // parseStoredFailureDetail above) so a later run's "same failure as last
  // run" comparison can see a kind change, not just message text — see
  // buildFailureComparisonKey's comment for why that matters.
  const detail = succeeded
    ? null
    : healthErrors
        .map((error) => `${error.kind}:${error.message}`)
        .join('\n')
        .slice(0, AGGREGATED_FAILURE_DETAIL_MAX_LENGTH);

  // Reconciles the shared sitewide alerts using this run as evidence, before
  // this search's own alert decision below — see reconcileSitewideAlertAsync
  // for why this collapses what would otherwise be one duplicate alert per
  // affected saved search. The two causes are independent (a search's run
  // never produces both — an offline run never reaches the per-URL loop
  // that could hit a Facebook-cookie failure), so both are always checked.
  const facebookCookieFailureNow = healthErrors.some(isFacebookCookieFailure);
  const touchedFacebookRecipe = summary.touchedRecipeNames.has('facebook');
  await reconcileSitewideAlertAsync(
    FACEBOOK_COOKIES_CAUSE,
    facebookCookieFailureNow,
    touchedFacebookRecipe,
    formatFacebookCookiesFailingMessage,
    formatFacebookCookiesRecoveredMessage,
    summary,
    deps
  );
  const networkUnreachableFailureNow = healthErrors.some(isNetworkUnreachableFailure);
  await reconcileSitewideAlertAsync(
    NETWORK_UNREACHABLE_CAUSE,
    networkUnreachableFailureNow,
    summary.wasOnline !== undefined,
    formatNetworkUnreachableFailingMessage,
    formatNetworkUnreachableRecoveredMessage,
    summary,
    deps
  );
  // Everything not already covered by a sitewide alert above — used below so
  // this search's own alert never repeats a line a sitewide alert just sent.
  const searchScopedHealthErrors = healthErrors.filter((error) => !isSitewideCoveredFailure(error));

  if (succeeded) {
    if (isSetupMoment) {
      await sendAlertSafelyAsync(
        formatAlertSetupSuccessMessage(row.name, summary.populatedCount),
        summary,
        deps
      );
    } else if (row.last_run_succeeded === 0) {
      // Only send this search's own recovery ping if its previous failure
      // wasn't entirely sitewide-covered — that edge is already covered by
      // the sitewide recovery alert(s) sent above.
      const previousErrors = parseStoredFailureDetail(row.last_run_detail);
      const wasPurelySitewideCoveredFailure =
        previousErrors.length > 0 && previousErrors.every(isSitewideCoveredFailure);
      if (!wasPurelySitewideCoveredFailure) {
        await sendAlertSafelyAsync(formatSearchRecoveredMessage(row.name), summary, deps);
      }
    }
    stmtUpdateSavedSearchRunStatus(deps.database).run(1, null, null, row.id);
    return;
  }

  const isSameFailureAsLastRun =
    row.last_run_succeeded === 0 &&
    buildFailureComparisonKey(parseStoredFailureDetail(row.last_run_detail)) ===
      buildFailureComparisonKey(healthErrors);
  const isWithinPerSearchReAlertWindow = isWithinReAlertWindow(
    isSameFailureAsLastRun,
    row.last_failure_alerted_at,
    deps.now()
  );

  // Every current health error for this search is already covered by a
  // sitewide alert above, so skip the redundant per-search send but still
  // persist state/detail (keep the prior last_failure_alerted_at rather than
  // advancing it, since no per-search alert actually went out). Setup
  // confirmations are exempt — a user who just turned alerts on for this
  // search needs to know *their* setup didn't complete, even though the
  // cause is application-wide.
  const isSitewideCoveredMoment = !isSetupMoment && searchScopedHealthErrors.length === 0;

  if (isWithinPerSearchReAlertWindow || isSitewideCoveredMoment) {
    stmtUpdateSavedSearchRunStatus(deps.database).run(
      0,
      detail,
      row.last_failure_alerted_at,
      row.id
    );
    return;
  }

  const failingMessage = (
    isSetupMoment
      ? formatAlertSetupFailedMessage(row.name, healthErrors)
      : formatSearchFailingMessage(row.name, searchScopedHealthErrors)
  ).slice(0, AGGREGATED_FAILURE_DETAIL_MAX_LENGTH);
  await sendAlertSafelyAsync(failingMessage, summary, deps);
  stmtUpdateSavedSearchRunStatus(deps.database).run(0, detail, deps.now(), row.id);
}

async function runOneSavedSearchAsync(
  row: SavedSearchRow,
  deps: Required<SchedulerDeps>
): Promise<SavedSearchRunSummary> {
  let summary: SavedSearchRunSummary;
  try {
    summary = await processSavedSearchAsync(row, deps);
  } catch (err) {
    // A synchronous throw (e.g. malformed row.urls JSON, SQLITE_BUSY) still
    // needs a result, and last_run_at below still needs to advance — otherwise
    // a permanently broken saved search would be picked as "due" forever and
    // starve every other alert-enabled saved search out of rotation.
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
      errors: [{ kind: 'unhandled', message: `Unhandled error: ${(err as Error).message}` }],
      touchedRecipeNames: new Set(),
    };
  }
  await recordSavedSearchRunStatusAndAlertAsync(row, summary, deps);
  stmtUpdateSavedSearchLastRunAt(deps.database).run(deps.now(), row.id);
  return summary;
}

export async function runSchedulerAsync(deps: SchedulerDeps): Promise<SchedulerSummary> {
  const resolvedDeps: Required<SchedulerDeps> = {
    now: () => Date.now(),
    targetIntervalMs: TARGET_INTERVAL_MINUTES * 60_000,
    maxSearchesPerTick: MAX_SEARCHES_PER_TICK,
    checkConnectivityAsync: checkInternetConnectivityAsync,
    ...deps,
  };
  const cutoff = resolvedDeps.now() - resolvedDeps.targetIntervalMs;
  // Counted before processing: once a row's last_run_at is updated below it
  // no longer counts as due, so this needs to capture the full backlog size
  // up front rather than what's left afterward.
  const dueCount = stmtCountDueAlertEnabledSavedSearches(resolvedDeps.database).get(cutoff)?.count;
  const rows = stmtGetDueAlertEnabledSavedSearches(resolvedDeps.database).all(
    cutoff,
    resolvedDeps.maxSearchesPerTick
  );
  if (rows.length === 0) return { searches: [] };

  const searches: SavedSearchRunSummary[] = [];
  for (const row of rows) searches.push(await runOneSavedSearchAsync(row, resolvedDeps));

  if (dueCount !== undefined && dueCount > rows.length) {
    console.warn(
      `[scheduler] capacity exceeded: ${dueCount} saved search(es) are due but only ` +
        `${rows.length} were processed this tick (maxSearchesPerTick=${resolvedDeps.maxSearchesPerTick}) — ` +
        'the remaining backlog will be picked up on later ticks, oldest first.'
    );
  }

  return { searches };
}

export type ImmediatePopulationRunDeps = {
  database: Database.Database;
  cooldownStore: ProviderCooldownStore;
  sendNotificationAsync?: SchedulerNotifier;
  checkConnectivityAsync?: () => Promise<boolean>;
};

// Forces a fresh, silent population pass for one specific saved search,
// regardless of whether has_completed_population_run is already set —
// existing alerted_listings rows are left untouched (population inserts are
// INSERT OR IGNORE). Reuses the same file lock as scripts/scheduler.ts so
// this can never run concurrently with a real cron pass; if the lock is
// already held, this defers gracefully (cron will pick the search up on its
// own rotation) rather than retrying — but first marks the row as owing a
// setup confirmation (stmtMarkAlertSetupNotificationPending), so whichever
// run eventually processes it still sends one instead of the deferral
// silently dropping it forever (see recordSavedSearchRunStatusAndAlertAsync).
// Every caller of this function only ever does so from an alert-on
// transition (create/PATCH/PUT with alerts on — see routes/savedSearches.ts),
// so marking pending here unconditionally is safe.
export async function runImmediatePopulationRunAsync(
  savedSearchId: string,
  deps: ImmediatePopulationRunDeps,
  lockPath: string = DEFAULT_SCHEDULER_LOCK_PATH
): Promise<void> {
  const lockResult = acquireSchedulerLock(lockPath);
  if (!lockResult.acquired) {
    console.log(
      `[scheduler] immediate population run for ${savedSearchId} deferred — ${lockResult.reason}`
    );
    stmtMarkAlertSetupNotificationPending(deps.database).run(savedSearchId);
    return;
  }
  try {
    const row = stmtGetSavedSearch(deps.database).get(savedSearchId);
    if (!row) return; // deleted/renamed away before this ran
    const resolvedDeps: Required<SchedulerDeps> = {
      database: deps.database,
      cooldownStore: deps.cooldownStore,
      sendNotificationAsync: deps.sendNotificationAsync ?? sendSignalNotificationAsync,
      checkConnectivityAsync: deps.checkConnectivityAsync ?? checkInternetConnectivityAsync,
      now: () => Date.now(),
      targetIntervalMs: TARGET_INTERVAL_MINUTES * 60_000,
      maxSearchesPerTick: MAX_SEARCHES_PER_TICK,
    };
    try {
      const summary = await processSavedSearchAsync(
        { ...row, has_completed_population_run: 0 },
        resolvedDeps
      );
      console.log(
        `[scheduler] "${row.name}": immediate population run complete — ${summary.populatedCount} baseline listing(s)`
      );
      await recordSavedSearchRunStatusAndAlertAsync(row, summary, resolvedDeps, {
        isImmediateSetupRun: true,
      });
    } catch (err) {
      // Mirrors runOneSavedSearchAsync's batch-path handling: last_run_at
      // below still needs to advance even on a synchronous throw (e.g.
      // malformed row.urls JSON), otherwise this saved search would be
      // retried on every future edit/create without ever recording an
      // attempt was made.
      console.error(
        `[scheduler] "${row.name}": immediate population run failed: ${(err as Error).message}`
      );
      await recordSavedSearchRunStatusAndAlertAsync(
        row,
        {
          savedSearchId: row.id,
          savedSearchName: row.name,
          isPopulationRun: true,
          listingsFoundCount: 0,
          soldSkippedCount: 0,
          aiFilteredOutCount: 0,
          alreadyAlertedCount: 0,
          notifiedCount: 0,
          populatedCount: 0,
          errors: [{ kind: 'unhandled', message: `Unhandled error: ${(err as Error).message}` }],
          touchedRecipeNames: new Set(),
        },
        resolvedDeps,
        { isImmediateSetupRun: true }
      );
    }
    stmtUpdateSavedSearchLastRunAt(resolvedDeps.database).run(resolvedDeps.now(), row.id);
  } finally {
    releaseSchedulerLock(lockPath);
  }
}

// Fire-and-forget wrapper for route handlers — returns void (not a Promise)
// so a call site can't accidentally await it and block the HTTP response.
// Any rejection from the underlying run is caught and logged here so it can
// never become an unhandled promise rejection.
export function triggerImmediatePopulationRunAsync(
  savedSearchId: string,
  deps: ImmediatePopulationRunDeps,
  lockPath: string = DEFAULT_SCHEDULER_LOCK_PATH
): void {
  runImmediatePopulationRunAsync(savedSearchId, deps, lockPath).catch((err) => {
    console.error(
      `[scheduler] immediate population run for ${savedSearchId} failed: ${(err as Error).message}`
    );
  });
}

// A single search hitting a notify error is just as likely to be one flaky
// send as anything systemic — recordSavedSearchRunStatusAndAlertAsync already
// excludes that from health. But several independent searches hitting a
// notify error in the very same tick is a much stronger signal that Signal
// delivery itself (not any one search) is broken — and that's exactly the
// failure mode a Signal-based alert can never report on its own. This lets
// scripts/scheduler.ts escalate that case through the exit-code path instead,
// which pages independently of whether Signal delivery is working.
export const MIN_SEARCHES_FOR_SYSTEMIC_NOTIFY_FAILURE = 2;

// Pure decision, no I/O — scripts/scheduler.ts's main() uses this for the
// process exit code while still logging every individual error itself.
export function determineExitCode(summary: SchedulerSummary): number {
  const searchesWithNotifyErrorCount = summary.searches.filter((search) =>
    search.errors.some((error) => error.kind === 'notify')
  ).length;
  if (searchesWithNotifyErrorCount >= MIN_SEARCHES_FOR_SYSTEMIC_NOTIFY_FAILURE) return 2;
  return summary.searches.some((search) => search.errors.length > 0) ? 1 : 0;
}
