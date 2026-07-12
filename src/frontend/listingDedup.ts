// Content-based duplicate detection — catches the same physical listing
// surfacing under two different URLs (e.g. a tracking query param, or the
// same item appearing via two different category searches), which exact-URL
// comparison misses.
import type { Listing } from '../lib/recipes/base';

// Strips the query string and fragment, since those commonly vary between
// two URLs that otherwise point at the same listing.
//
// Listing URLs originate from network responses (recipe scrapers), so a
// malformed or relative URL is expected input, not a bug — `new URL()`
// throws on those, and this is the only caller reached from
// streamPostAsync's onData dispatch, whose blanket try/catch would
// otherwise silently drop the whole listing. Falling back to the raw
// string keeps the listing visible (deduping less aggressively) instead
// of disappearing without explanation.
export function baseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

// A null-char separator keeps adjacent fields from colliding at their
// boundary (e.g. title "ab" + description "c" vs title "a" + description "bc").
//
// price is included deliberately: two listings that share title/location/
// description but differ in price are treated as distinct, not as the same
// listing re-priced. String(price) keeps `null` (no price given) distinct
// from any numeric price, including 0.
//
// Returned as the raw composite string rather than a hash: callers use it as
// a Map key, and hashing it down to a 32-bit int first would only add
// collision risk (two distinct listings mapping to the same hash and being
// wrongly treated as duplicates) for no benefit — string keys are just as
// fast to look up.
export function listingDedupeKey(listing: Listing): string {
  return [
    baseUrl(listing.url),
    listing.title,
    listing.description ?? '',
    listing.location,
    String(listing.price),
  ].join('\0');
}
