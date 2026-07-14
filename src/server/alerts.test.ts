import { describe, expect, it } from 'vitest';
import { makeListing } from '../lib/testFixtures';
import { computeListingAlertHash } from './alerts';

describe('computeListingAlertHash', () => {
  it('is deterministic for the same listing', () => {
    const listing = makeListing();
    expect(computeListingAlertHash(listing)).toBe(computeListingAlertHash(listing));
  });

  it('is the same for a listing relisted under a different URL id/query string', () => {
    const original = makeListing({ url: 'https://example.com/listing/111?ref=facebook' });
    const relisted = makeListing({ url: 'https://example.com/listing/111?ref=trademe' });
    expect(computeListingAlertHash(original)).toBe(computeListingAlertHash(relisted));
  });

  it('differs when the title differs', () => {
    const a = makeListing({ title: 'Vintage lamp' });
    const b = makeListing({ title: 'Modern lamp' });
    expect(computeListingAlertHash(a)).not.toBe(computeListingAlertHash(b));
  });

  it('differs when the base URL differs (a genuinely different listing)', () => {
    const a = makeListing({ url: 'https://example.com/listing/1' });
    const b = makeListing({ url: 'https://example.com/listing/2' });
    expect(computeListingAlertHash(a)).not.toBe(computeListingAlertHash(b));
  });

  it('returns a compact hex string, not the raw composite key', () => {
    const listing = makeListing();
    const hash = computeListingAlertHash(listing);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash).not.toContain(listing.title);
  });
});
