// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Listing } from '../lib/recipes/base';
import type { RecipeSource } from '../lib/recipes/metadata';
import { DEFAULT_SORT_OPTION, SORT_OPTIONS, sortListings } from './sortListings';
import type { ListingItem } from './state';

function makeListingItem(
  url: string,
  relevance: number,
  price: number | null,
  source: RecipeSource = 'trademe'
): ListingItem {
  return {
    data: { source, title: url, price, location: '', url, relevance } as Listing,
    hasBeenDeepSearched: false,
    aiCheckedHash: null,
    aiFilterReason: null,
  };
}

describe('sortListings', () => {
  it('leaves source-url order untouched when all listings share one source', () => {
    const listings = [
      makeListingItem('a', 3, 10),
      makeListingItem('b', 9, 5),
      makeListingItem('c', 1, 20),
    ];
    expect(sortListings(listings, 'source-url').map((item) => item.data.url)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('groups trademe and trademe-expired listings together, ahead of facebook, preserving relative order within each group', () => {
    const listings = [
      makeListingItem('a', 0, 0, 'facebook'),
      makeListingItem('b', 0, 0, 'trademe'),
      makeListingItem('c', 0, 0, 'facebook'),
      makeListingItem('d', 0, 0, 'trademe-expired'),
      makeListingItem('e', 0, 0, 'trademe'),
    ];
    expect(sortListings(listings, 'source-url').map((item) => item.data.url)).toEqual([
      'b',
      'd',
      'e',
      'a',
      'c',
    ]);
  });

  it('sorts by relevance descending for best-match, preserving order on ties', () => {
    const listings = [
      makeListingItem('a', 3, 10),
      makeListingItem('b', 9, 5),
      makeListingItem('c', 3, 20),
    ];
    expect(sortListings(listings, 'best-match').map((item) => item.data.url)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('sorts by relevance ascending for worst-match, preserving order on ties', () => {
    const listings = [
      makeListingItem('a', 3, 10),
      makeListingItem('b', 9, 5),
      makeListingItem('c', 3, 20),
    ];
    expect(sortListings(listings, 'worst-match').map((item) => item.data.url)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('sorts by price ascending for lowest-price, with null prices last', () => {
    const listings = [
      makeListingItem('a', 0, 30),
      makeListingItem('b', 0, null),
      makeListingItem('c', 0, 10),
    ];
    expect(sortListings(listings, 'lowest-price').map((item) => item.data.url)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('sorts by price descending for highest-price, with null prices still last', () => {
    const listings = [
      makeListingItem('a', 0, 30),
      makeListingItem('b', 0, null),
      makeListingItem('c', 0, 10),
    ];
    expect(sortListings(listings, 'highest-price').map((item) => item.data.url)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('preserves original order for equal prices', () => {
    const listings = [
      makeListingItem('a', 0, 10),
      makeListingItem('b', 0, 10),
      makeListingItem('c', 0, 5),
    ];
    expect(sortListings(listings, 'lowest-price').map((item) => item.data.url)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('does not mutate the input array', () => {
    const listings = [makeListingItem('a', 1, 10), makeListingItem('b', 9, 5)];
    const original = [...listings];
    sortListings(listings, 'best-match');
    expect(listings).toEqual(original);
  });
});

describe('SORT_OPTIONS / DEFAULT_SORT_OPTION', () => {
  it('defaults to source-url', () => {
    expect(DEFAULT_SORT_OPTION).toBe('source-url');
  });

  it('lists all five options in the required order', () => {
    expect(SORT_OPTIONS.map((option) => option.value)).toEqual([
      'source-url',
      'best-match',
      'worst-match',
      'lowest-price',
      'highest-price',
    ]);
  });
});
