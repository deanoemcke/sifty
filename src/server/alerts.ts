// Server-side only — listing identity hashing for the alert scheduler.
// node:crypto is Node-only, so this stays out of src/lib (bundled into the
// frontend too).

import { createHash } from 'node:crypto';
import type { Listing } from '../lib/recipes/base';

// Deliberately excludes the URL entirely — unlike listingDedupeKey (which
// only strips the query string, for same-session near-duplicate detection),
// a relisted item gets a brand new listing ID in the URL *path* on the
// source site, and re-alerting on the same physical item every time it's
// relisted would be exactly the spam this hash exists to prevent. Title +
// location + description + price is a good enough fingerprint for "the same
// physical item" across relistings.
export function computeListingAlertHash(listing: Listing): string {
  const composite = [
    listing.title,
    listing.location,
    listing.description ?? '',
    String(listing.price),
  ].join('\0');
  return createHash('sha256').update(composite).digest('hex');
}
