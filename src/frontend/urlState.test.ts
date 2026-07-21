import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_LISTING_VISIBILITY_CATEGORIES,
  resetState,
  setActiveSidebarTab,
  setCurrentSearchId,
  setListingCategoryVisible,
  setOpenModalListingUrl,
  setSortBy,
} from './state';
import { parseUrlState, serializeStateToSearchParams } from './urlState';

describe('serializeStateToSearchParams', () => {
  beforeEach(() => resetState());

  it('produces an empty query string on defaults', () => {
    expect(serializeStateToSearchParams().toString()).toBe('');
  });

  it('encodes a non-default tab', () => {
    setActiveSidebarTab('favourites');
    expect(serializeStateToSearchParams().get('tab')).toBe('favourites');
  });

  it('omits tab when it is the default', () => {
    setActiveSidebarTab('search');
    expect(serializeStateToSearchParams().get('tab')).toBe(null);
  });

  it('encodes a non-default sort', () => {
    setSortBy('lowest-price');
    expect(serializeStateToSearchParams().get('sort')).toBe('lowest-price');
  });

  it('omits sort when it is the default', () => {
    expect(serializeStateToSearchParams().get('sort')).toBe(null);
  });

  it('encodes a reduced visible-category set', () => {
    setListingCategoryVisible('sold', false);
    setListingCategoryVisible('filtered', false);
    expect(serializeStateToSearchParams().get('show')).toBe('used,new');
  });

  it('omits show when every category is visible', () => {
    expect(serializeStateToSearchParams().get('show')).toBe(null);
  });

  it('encodes the open modal listing url', () => {
    setOpenModalListingUrl('https://trademe.co.nz/listing/1');
    expect(serializeStateToSearchParams().get('modal')).toBe('https://trademe.co.nz/listing/1');
  });

  it('omits modal when no modal is open', () => {
    expect(serializeStateToSearchParams().get('modal')).toBe(null);
  });

  it('encodes the loaded saved-search id', () => {
    setCurrentSearchId('abc123');
    expect(serializeStateToSearchParams().get('search')).toBe('abc123');
  });

  it('omits search when no saved search is loaded', () => {
    expect(serializeStateToSearchParams().get('search')).toBe(null);
  });
});

describe('parseUrlState', () => {
  it('returns all defaults for an empty query string', () => {
    const parsed = parseUrlState(new URLSearchParams(''));
    expect(parsed).toEqual({
      tab: 'search',
      sort: 'source-url',
      visibleCategories: new Set(ALL_LISTING_VISIBILITY_CATEGORIES),
      modalListingUrl: null,
      savedSearchId: null,
    });
  });

  it('rejects an unknown tab value to the default', () => {
    expect(parseUrlState(new URLSearchParams('tab=bogus')).tab).toBe('search');
  });

  it('accepts a known tab value', () => {
    expect(parseUrlState(new URLSearchParams('tab=favourites')).tab).toBe('favourites');
  });

  it('rejects an unknown sort value to the default', () => {
    expect(parseUrlState(new URLSearchParams('sort=bogus')).sort).toBe('source-url');
  });

  it('accepts a known sort value', () => {
    expect(parseUrlState(new URLSearchParams('sort=highest-price')).sort).toBe('highest-price');
  });

  it('falls back to the full category set when show is entirely unrecognised', () => {
    const parsed = parseUrlState(new URLSearchParams('show=bogus'));
    expect(parsed.visibleCategories).toEqual(new Set(ALL_LISTING_VISIBILITY_CATEGORIES));
  });

  it('keeps only recognised category tokens', () => {
    const parsed = parseUrlState(new URLSearchParams('show=used,bogus'));
    expect(parsed.visibleCategories).toEqual(new Set(['used']));
  });

  it('passes through a modal url unvalidated, deferring validity to apply-time', () => {
    const parsed = parseUrlState(new URLSearchParams('modal=https://trademe.co.nz/listing/1'));
    expect(parsed.modalListingUrl).toBe('https://trademe.co.nz/listing/1');
  });

  it('passes through a search id unvalidated, deferring validity to apply-time', () => {
    expect(parseUrlState(new URLSearchParams('search=abc123')).savedSearchId).toBe('abc123');
  });
});
