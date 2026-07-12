// Content-based duplicate detection — catches the same physical listing
// surfacing under two different URLs (e.g. a tracking query param, or the
// same item appearing via two different category searches), which exact-URL
// comparison misses.
import type { Listing } from '../lib/recipes/base';
import { djb2Hash } from './renderUtils';

// Strips the query string and fragment, since those commonly vary between
// two URLs that otherwise point at the same listing.
export function baseUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

// A null-char separator keeps adjacent fields from colliding at their
// boundary (e.g. title "ab" + description "c" vs title "a" + description "bc").
//
// price is included deliberately: two listings that share title/location/
// description but differ in price are treated as distinct, not as the same
// listing re-priced. String(price) keeps `null` (no price given) distinct
// from any numeric price, including 0.
export function listingDedupeKey(listing: Listing): number {
  return djb2Hash(
    [
      baseUrl(listing.url),
      listing.title,
      listing.description ?? '',
      listing.location,
      String(listing.price),
    ].join('\0')
  );
}
