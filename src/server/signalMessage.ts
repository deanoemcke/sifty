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
