// Server-side only — listing identity hashing for the alert scheduler.
// node:crypto is Node-only, so this stays out of src/lib (bundled into the
// frontend too) even though it wraps a src/lib helper.

import { createHash } from 'node:crypto';
import { listingDedupeKey } from '../lib/listingDedup';
import type { Listing } from '../lib/recipes/base';

// Deliberately derived from content (title/base URL/location/price), never
// from a listing ID — a relisted item gets a new ID on the source site, and
// re-alerting on the same physical item every time it's relisted would be
// exactly the spam this hash exists to prevent.
export function computeListingAlertHash(listing: Listing): string {
  return createHash('sha256').update(listingDedupeKey(listing)).digest('hex');
}
