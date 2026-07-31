// Server-side only — formats saved-search alerts for the Signal proxy's
// markdown subset. Single consumer: the headless scheduler (scheduler.ts).

import { formatListingPrice } from '../lib/priceFormat';
import type { Listing } from '../lib/recipes/base';

// Trailing comma-segments that identify the regiona and country rather than the suburb
function stripLocationSuffix(location: string): string {
  const firstCommaIndex = location.indexOf(',');
  if (firstCommaIndex === -1) {
    return location;
  }
  return location.slice(0, firstCommaIndex).trim();
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
// recordSavedSearchRunStatusAndAlertAsync in scheduler.ts). One plain line
// per distinct error — no header, no markdown emphasis — so it reads at a
// glance in the Signal thread rather than as a log dump.
export function formatSearchFailingMessage(savedSearchName: string, errors: string[]): string {
  const escapedName = escapeSignalMarkdown(savedSearchName);
  return [...new Set(errors)]
    .map((error) => `Scrape error - ${escapedName}. ${escapeSignalMarkdown(error)}`)
    .join('\n');
}

// Composes the counterpart recovery alert, sent on the failure→success edge
// — the moment a previously-failing saved search's scheduled run succeeds.
export function formatSearchRecoveredMessage(savedSearchName: string): string {
  return `✅ ${escapeSignalMarkdown(savedSearchName)} is working again`;
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
// underlying error shape.
export function formatAlertSetupFailedMessage(savedSearchName: string, errors: string[]): string {
  const escapedName = escapeSignalMarkdown(savedSearchName);
  return [
    `⚠️ Couldn't set up alerts for "${escapedName}":`,
    ...[...new Set(errors)].map((error) => `- ${escapeSignalMarkdown(error)}`),
  ].join('\n');
}
