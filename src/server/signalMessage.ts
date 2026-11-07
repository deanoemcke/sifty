// Server-side only — formats saved-search alerts for the Signal proxy's
// markdown subset. Single consumer: the headless scheduler (scheduler.ts).

import { formatListingPrice } from '../lib/priceFormat';
import type { Listing } from '../lib/recipes/base';
import type { SchedulerError, SchedulerErrorKind } from './scheduler';
import { normalizeScrapeErrorReason } from './schedulerErrorText';

const ERROR_KIND_LABEL: Record<SchedulerErrorKind, string> = {
  scrape: 'Scrape',
  'ai-filter': 'AI Filter',
  notify: 'Notify',
  'notify-image': 'Notify image',
  unhandled: 'Unhandled',
};

type ErrorSeverity = 'critical' | 'high' | 'medium';

const ERROR_KIND_SEVERITY: Record<SchedulerErrorKind, ErrorSeverity> = {
  unhandled: 'critical',
  scrape: 'high',
  'ai-filter': 'medium',
  notify: 'medium',
  'notify-image': 'medium',
};

const SEVERITY_ICON: Record<ErrorSeverity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
};

// De-dupes on the (kind, normalized-message) pair rather than kind+message
// alone — two different subsystems could in principle produce the same
// text, and two errors describing the identical root cause (e.g. a total
// network outage) but different URLs must still collapse to one line
// rather than one per URL. Keys on normalizeScrapeErrorReason's output —
// the same normalization scheduler.ts already trusts for its own
// "same failure as last run" comparison — rather than the raw message.
function dedupeErrors(errors: SchedulerError[]): SchedulerError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = `${error.kind}:${normalizeScrapeErrorReason(error.message)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function severityIcon(error: SchedulerError): string {
  return SEVERITY_ICON[ERROR_KIND_SEVERITY[error.kind]];
}

function categorizedErrorLine(error: SchedulerError): string {
  const label = ERROR_KIND_LABEL[error.kind];
  return `[${label}] ${escapeSignalMarkdown(error.message)}`;
}

// Trailing comma-segments that identify the regiona and country rather than the suburb
function stripLocationSuffix(location: string): string {
  const firstCommaIndex = location.indexOf(',');
  if (firstCommaIndex === -1) {
    return location;
  }
  return location.slice(0, firstCommaIndex).trim();
}

const TRUNCATION_MARKER = '…';

export function truncateToByteLength(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const marker = maxBytes >= markerBytes ? TRUNCATION_MARKER : '';
  const contentBudgetBytes = maxBytes - Buffer.byteLength(marker, 'utf8');
  let byteCount = 0;
  let endIndex = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteCount + characterBytes > contentBudgetBytes) break;
    byteCount += characterBytes;
    endIndex += character.length;
  }
  return text.slice(0, endIndex) + marker;
}

// Strips the four characters the Signal proxy's regex-based markdown
// converter treats as style markers (**, _..._, `...`, ~~). Inserting an
// invisible character next to a marker only defeats markers that require
// doubling (**, ~~) — a lone _ or ` still matches a single-character
// delimiter regex regardless of what surrounds it, and a marker adjacent to
// a caller-supplied wrapper (formatAlertMessage's own **) can still merge
// into an unbroken run. Removing the characters outright is correct
// regardless of delimiter width or surrounding context, at the cost of
// altering the visible text (e.g. `Model_X` renders as `ModelX`).
export function escapeSignalMarkdown(text: string): string {
  return text.replace(/[*_`~]/g, '');
}

// Emulates the results-grid listing card as closely as the Signal proxy's
// markdown subset allows: bold title (the card's dominant element), then
// location/price on one line (the card's footer, collapsed into text), then
// the link. The saved search name and source are deliberately omitted —
// they're metadata about how the alert was found, not about the listing.
// `url` is deliberately never escaped — it must stay byte-identical to
// `listing.url` so Signal's client-side auto-linkify isn't broken.
export function formatAlertMessage(listing: Listing): string {
  const price = formatListingPrice(listing.price);
  return [
    `**${escapeSignalMarkdown(listing.title)}**`,
    `${escapeSignalMarkdown(stripLocationSuffix(listing.location))} · ${price}`,
    listing.url,
  ].join('\n');
}

// Composes a terse system-health Signal alert for a saved search whose most
// recent scheduled run failed, sent only on the success→failure edge (or on
// a same-failure re-alert after the 12h window — see
// recordSavedSearchRunStatusAndAlertAsync in scheduler.ts). One line per
// distinct error, each tagged with its subsystem and a severity icon (see
// ERROR_KIND_LABEL/ERROR_KIND_SEVERITY above) so a failure can be triaged —
// which part broke, how badly — straight from the Signal thread rather than
// requiring a log dive. No header beyond that, so it still reads at a glance.
export function formatSearchFailingMessage(
  savedSearchName: string,
  errors: SchedulerError[]
): string {
  const escapedName = escapeSignalMarkdown(savedSearchName);
  return dedupeErrors(errors)
    .map((error) => `${severityIcon(error)} ${escapedName}: ${categorizedErrorLine(error)}`)
    .join('\n');
}

// Composes the counterpart recovery alert, sent on the failure→success edge
// — the moment a previously-failing saved search's scheduled run succeeds.
export function formatSearchRecoveredMessage(savedSearchName: string): string {
  return `✅ ${escapeSignalMarkdown(savedSearchName)} is working again`;
}

// Application-wide counterpart to formatSearchFailingMessage — sent once,
// covering every affected saved search at once, instead of once per search
// (see reconcileSitewideAlertAsync in scheduler.ts, which dedupes this exact
// scenario across saved searches).
export function formatFacebookCookiesFailingMessage(): string {
  return '🟠 Facebook login required — set FB_COOKIES to restore all Facebook-based searches.';
}

// Application-wide counterpart to formatSearchRecoveredMessage — sent once
// when the shared Facebook-cookies failure clears, instead of once per
// affected saved search.
export function formatFacebookCookiesRecoveredMessage(): string {
  return '✅ Facebook login is working again';
}

// Application-wide counterpart to formatSearchFailingMessage for a total
// connectivity outage — every alert-enabled saved search independently
// skips its scrape for the identical reason on the same tick, so this
// collapses that into one alert instead of one per search (see
// reconcileSitewideAlertAsync in scheduler.ts).
export function formatNetworkUnreachableFailingMessage(): string {
  return '🟠 Network unreachable — skipped this run for every alert-enabled saved search.';
}

// Application-wide counterpart to formatSearchRecoveredMessage — sent once
// when connectivity returns, instead of once per affected saved search.
export function formatNetworkUnreachableRecoveredMessage(): string {
  return '✅ Network connectivity is working again';
}

// Sent once, right when a saved search's alert finishes being set up — i.e.
// the immediate, silent population run triggered by turning the alert
// checkbox on (or editing an already alert-on search) completes
// successfully. Distinct from formatSearchRecoveredMessage, which only
// covers a previously-*failing* search recovering, not this first-time
// "your alert is now live" confirmation.
export function formatAlertSetupSuccessMessage(
  savedSearchName: string,
  baselineListingCount: number
): string {
  const escapedName = escapeSignalMarkdown(savedSearchName);
  return `✅ Alerts set up for "${escapedName}" — recorded ${baselineListingCount} existing listing(s) as the starting point. You'll be notified about new ones from here.`;
}

// Counterpart failure message for the same "just finished setting up alerts"
// moment — distinguishes a setup failure from formatSearchFailingMessage's
// ongoing steady-state scrape-failure alert, even though both share the same
// underlying error shape (and the same per-error category/severity tagging).
export function formatAlertSetupFailedMessage(
  savedSearchName: string,
  errors: SchedulerError[]
): string {
  const escapedName = escapeSignalMarkdown(savedSearchName);
  return [
    `⚠️ Couldn't set up alerts for "${escapedName}":`,
    ...dedupeErrors(errors).map(
      (error) => `- ${severityIcon(error)} ${categorizedErrorLine(error)}`
    ),
  ].join('\n');
}
