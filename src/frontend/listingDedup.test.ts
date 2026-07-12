import { describe, expect, it } from 'vitest';
import { baseUrl, listingDedupeKey } from './listingDedup';
import { makeListing } from './testFixtures';

describe('baseUrl', () => {
  it('strips the query string', () => {
    expect(baseUrl('https://example.com/listing/1?ref=abc&page=2')).toBe(
      'https://example.com/listing/1'
    );
  });

  it('strips the fragment', () => {
    expect(baseUrl('https://example.com/listing/1#photos')).toBe('https://example.com/listing/1');
  });

  it('leaves a URL with no query or fragment untouched', () => {
    expect(baseUrl('https://example.com/listing/1')).toBe('https://example.com/listing/1');
  });

  it('falls back to the raw string for a malformed URL instead of throwing', () => {
    expect(() => baseUrl('not a url')).not.toThrow();
    expect(baseUrl('not a url')).toBe('not a url');
  });

  it('falls back to the raw string for a relative URL instead of throwing', () => {
    expect(() => baseUrl('/listing/1?ref=abc')).not.toThrow();
    expect(baseUrl('/listing/1?ref=abc')).toBe('/listing/1?ref=abc');
  });
});

describe('listingDedupeKey', () => {
  it('is the same for two listings that differ only by URL query string', () => {
    const a = makeListing({ url: 'https://example.com/listing/1?ref=facebook' });
    const b = makeListing({ url: 'https://example.com/listing/1?ref=trademe' });
    expect(listingDedupeKey(a)).toBe(listingDedupeKey(b));
  });

  it('differs when the base URL differs', () => {
    const a = makeListing({ url: 'https://example.com/listing/1' });
    const b = makeListing({ url: 'https://example.com/listing/2' });
    expect(listingDedupeKey(a)).not.toBe(listingDedupeKey(b));
  });

  it('differs when the title differs', () => {
    const a = makeListing({ title: 'Vintage lamp' });
    const b = makeListing({ title: 'Modern lamp' });
    expect(listingDedupeKey(a)).not.toBe(listingDedupeKey(b));
  });

  it('differs when the location differs', () => {
    const a = makeListing({ location: 'Wellington' });
    const b = makeListing({ location: 'Auckland' });
    expect(listingDedupeKey(a)).not.toBe(listingDedupeKey(b));
  });

  it('differs when the description differs', () => {
    const a = makeListing({ description: 'Barely used' });
    const b = makeListing({ description: 'Brand new' });
    expect(listingDedupeKey(a)).not.toBe(listingDedupeKey(b));
  });

  it('treats an absent description the same as an empty-string description', () => {
    const a = makeListing({ description: undefined });
    const b = makeListing({ description: '' });
    expect(listingDedupeKey(a)).toBe(listingDedupeKey(b));
  });

  it('differs when the price differs, even with identical title/location/description', () => {
    const a = makeListing({
      title: 'Vintage lamp',
      description: '',
      location: 'Wellington',
      price: 50,
    });
    const b = makeListing({
      title: 'Vintage lamp',
      description: '',
      location: 'Wellington',
      price: 75,
    });
    expect(listingDedupeKey(a)).not.toBe(listingDedupeKey(b));
  });

  it('is deterministic for the same listing', () => {
    const listing = makeListing();
    expect(listingDedupeKey(listing)).toBe(listingDedupeKey(listing));
  });

  it('does not throw when the URL is malformed', () => {
    const listing = makeListing({ url: 'not a url' });
    expect(() => listingDedupeKey(listing)).not.toThrow();
  });
});
