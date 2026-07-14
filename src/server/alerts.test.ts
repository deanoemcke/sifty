import { describe, expect, it } from 'vitest';
import { makeListing } from '../lib/testFixtures';
import { computeListingAlertHash } from './alerts';

describe('computeListingAlertHash', () => {
  it('is deterministic for the same listing', () => {
    const listing = makeListing();
    expect(computeListingAlertHash(listing)).toBe(computeListingAlertHash(listing));
  });

  it('is the same for a listing relisted under a different URL id (a new listing ID in the path, not just the query string)', () => {
    const original = makeListing({ url: 'https://example.com/marketplace/listing/111' });
    const relisted = makeListing({ url: 'https://example.com/marketplace/listing/999' });
    expect(computeListingAlertHash(original)).toBe(computeListingAlertHash(relisted));
  });

  it('ignores the URL entirely — same content, wildly different URL, same hash', () => {
    const a = makeListing({ url: 'https://trademe.co.nz/a/marketplace/for-sale/listing/1' });
    const b = makeListing({ url: 'https://facebook.com/marketplace/item/999999999' });
    expect(computeListingAlertHash(a)).toBe(computeListingAlertHash(b));
  });

  it('differs when the title differs', () => {
    const a = makeListing({ title: 'Vintage lamp' });
    const b = makeListing({ title: 'Modern lamp' });
    expect(computeListingAlertHash(a)).not.toBe(computeListingAlertHash(b));
  });

  it('differs when the location differs', () => {
    const a = makeListing({ location: 'Wellington' });
    const b = makeListing({ location: 'Auckland' });
    expect(computeListingAlertHash(a)).not.toBe(computeListingAlertHash(b));
  });

  it('differs when the price differs', () => {
    const a = makeListing({ price: 50 });
    const b = makeListing({ price: 75 });
    expect(computeListingAlertHash(a)).not.toBe(computeListingAlertHash(b));
  });

  it('differs when the description differs', () => {
    const a = makeListing({ description: 'Barely used' });
    const b = makeListing({ description: 'Brand new' });
    expect(computeListingAlertHash(a)).not.toBe(computeListingAlertHash(b));
  });

  it('treats an absent description the same as an empty-string description', () => {
    const a = makeListing({ description: undefined });
    const b = makeListing({ description: '' });
    expect(computeListingAlertHash(a)).toBe(computeListingAlertHash(b));
  });

  it('returns a compact hex string, not the raw composite key', () => {
    const listing = makeListing();
    const hash = computeListingAlertHash(listing);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash).not.toContain(listing.title);
  });
});
