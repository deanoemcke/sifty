import { beforeEach, describe, expect, it } from 'vitest';
import { listingDedupeKey } from '../lib/listingDedup';
import {
  addListingItem,
  aiFilterPendingRun,
  bulkDeepSearchUrls,
  canCancelSearch,
  clearListings,
  getListingCategory,
  isAiFilterRunning,
  isCardSearchActive,
  isSearchButtonDisabled,
  listingsByUrl,
  listingUrlByDedupeKey,
  openModalListingUrl,
  removeListingByUrl,
  resetState,
  setAiFilterPendingRun,
  setBulkDeepSearchUrls,
  setIsAiFilterRunning,
  setListingCategoryVisible,
  setOpenModalListingUrl,
  singleDeepSearchInFlightUrls,
  visibleListingCategories,
} from './state';
import { makeListingItem } from './testFixtures';

describe('isSearchButtonDisabled', () => {
  it('returns false when idle and URL is fresh', () => {
    expect(isSearchButtonDisabled('idle', '', 'https://trademe.co.nz/search')).toBe(false);
  });

  it('returns true when searching', () => {
    expect(isSearchButtonDisabled('searching', '', 'https://trademe.co.nz/search')).toBe(true);
  });

  it('returns true when cancelling', () => {
    expect(isSearchButtonDisabled('cancelling', '', 'https://trademe.co.nz/search')).toBe(true);
  });

  it('returns true when done and input matches previously searched URL', () => {
    const url = 'https://trademe.co.nz/search';
    expect(isSearchButtonDisabled('done', url, url)).toBe(true);
  });

  it('returns false when done and input differs from previously searched URL', () => {
    expect(
      isSearchButtonDisabled('done', 'https://trademe.co.nz/search', 'https://trademe.co.nz/other')
    ).toBe(false);
  });
});

describe('canCancelSearch', () => {
  it('returns true when searching', () => {
    expect(canCancelSearch('searching')).toBe(true);
  });

  it('returns false when idle', () => {
    expect(canCancelSearch('idle')).toBe(false);
  });

  it('returns false when cancellation already requested', () => {
    expect(canCancelSearch('cancelling')).toBe(false);
  });

  it('returns false when done', () => {
    expect(canCancelSearch('done')).toBe(false);
  });
});

describe('isAiFilterRunning / aiFilterPendingRun', () => {
  beforeEach(() => resetState());

  it('defaults to false', () => {
    expect(isAiFilterRunning).toBe(false);
    expect(aiFilterPendingRun).toBe(false);
  });

  it('setIsAiFilterRunning updates the flag', () => {
    setIsAiFilterRunning(true);
    expect(isAiFilterRunning).toBe(true);
    setIsAiFilterRunning(false);
    expect(isAiFilterRunning).toBe(false);
  });

  it('setAiFilterPendingRun updates the flag', () => {
    setAiFilterPendingRun(true);
    expect(aiFilterPendingRun).toBe(true);
    setAiFilterPendingRun(false);
    expect(aiFilterPendingRun).toBe(false);
  });

  it('resetState clears both flags', () => {
    setIsAiFilterRunning(true);
    setAiFilterPendingRun(true);
    resetState();
    expect(isAiFilterRunning).toBe(false);
    expect(aiFilterPendingRun).toBe(false);
  });
});

describe('openModalListingUrl', () => {
  beforeEach(() => resetState());

  it('defaults to null', () => {
    expect(openModalListingUrl).toBe(null);
  });

  it('setOpenModalListingUrl updates the value', () => {
    setOpenModalListingUrl('https://trademe.co.nz/listing/1');
    expect(openModalListingUrl).toBe('https://trademe.co.nz/listing/1');
    setOpenModalListingUrl(null);
    expect(openModalListingUrl).toBe(null);
  });

  it('resetState clears it back to null', () => {
    setOpenModalListingUrl('https://trademe.co.nz/listing/1');
    resetState();
    expect(openModalListingUrl).toBe(null);
  });
});

describe('visibleListingCategories', () => {
  beforeEach(() => resetState());

  it('defaults to every category except filtered', () => {
    expect([...visibleListingCategories].sort()).toEqual(['new', 'sold', 'used']);
  });

  it('resetState refills it back to the default, excluding filtered', () => {
    setListingCategoryVisible('sold', false);
    setListingCategoryVisible('filtered', true);
    resetState();
    expect([...visibleListingCategories].sort()).toEqual(['new', 'sold', 'used']);
  });
});

describe('setListingCategoryVisible', () => {
  beforeEach(() => resetState());

  it('adds the category when visible', () => {
    setListingCategoryVisible('sold', false);
    setListingCategoryVisible('sold', true);
    expect(visibleListingCategories.has('sold')).toBe(true);
  });

  it('removes the category when not visible', () => {
    setListingCategoryVisible('filtered', false);
    expect(visibleListingCategories.has('filtered')).toBe(false);
  });
});

describe('getListingCategory', () => {
  it('returns filtered when aiFilterReason is set, even when isSold is true', () => {
    const item = makeListingItem({
      aiFilterReason: 'too old',
      data: { ...makeListingItem().data, isSold: true },
    });
    expect(getListingCategory(item)).toBe('filtered');
  });

  it('returns sold when isSold is true and not filtered', () => {
    const item = makeListingItem({
      aiFilterReason: null,
      data: { ...makeListingItem().data, isSold: true },
    });
    expect(getListingCategory(item)).toBe('sold');
  });

  it('returns used when neither filtered nor sold nor new', () => {
    const item = makeListingItem({ aiFilterReason: null });
    expect(getListingCategory(item)).toBe('used');
  });

  it('returns new when isNewFromSearch is true and not filtered or sold', () => {
    const item = makeListingItem({
      aiFilterReason: null,
      isNewFromSearch: true,
    });
    expect(getListingCategory(item)).toBe('new');
  });

  it('returns sold when both isNewFromSearch and isSold are true', () => {
    const item = makeListingItem({
      aiFilterReason: null,
      data: { ...makeListingItem().data, isSold: true },
      isNewFromSearch: true,
    });
    expect(getListingCategory(item)).toBe('sold');
  });

  it('returns filtered when isNewFromSearch is true but aiFilterReason is set', () => {
    const item = makeListingItem({
      aiFilterReason: 'too old',
      isNewFromSearch: true,
    });
    expect(getListingCategory(item)).toBe('filtered');
  });
});

describe('bulkDeepSearchUrls', () => {
  beforeEach(() => resetState());

  it('defaults to null', () => {
    expect(bulkDeepSearchUrls).toBe(null);
  });

  it('setBulkDeepSearchUrls updates the value', () => {
    const urls = new Set(['https://trademe.co.nz/listing/1']);
    setBulkDeepSearchUrls(urls);
    expect(bulkDeepSearchUrls).toBe(urls);
    setBulkDeepSearchUrls(null);
    expect(bulkDeepSearchUrls).toBe(null);
  });

  it('resetState clears it back to null', () => {
    setBulkDeepSearchUrls(new Set(['https://trademe.co.nz/listing/1']));
    resetState();
    expect(bulkDeepSearchUrls).toBe(null);
  });
});

describe('singleDeepSearchInFlightUrls', () => {
  beforeEach(() => resetState());

  it('starts empty', () => {
    expect(singleDeepSearchInFlightUrls.size).toBe(0);
  });

  it('resetState clears it', () => {
    singleDeepSearchInFlightUrls.add('https://trademe.co.nz/listing/1');
    resetState();
    expect(singleDeepSearchInFlightUrls.size).toBe(0);
  });
});

describe('addListingItem / removeListingByUrl / clearListings', () => {
  beforeEach(() => resetState());

  it('addListingItem populates both listingsByUrl and listingUrlByDedupeKey', () => {
    const item = makeListingItem();
    addListingItem(item);

    expect(listingsByUrl.get(item.data.url)).toBe(item);
    expect(listingUrlByDedupeKey.get(listingDedupeKey(item.data))).toBe(item.data.url);
  });

  it('removeListingByUrl removes the entry from both maps', () => {
    const item = makeListingItem();
    addListingItem(item);

    removeListingByUrl(item.data.url);

    expect(listingsByUrl.has(item.data.url)).toBe(false);
    expect(listingUrlByDedupeKey.has(listingDedupeKey(item.data))).toBe(false);
  });

  it('removeListingByUrl on an unknown URL is a no-op, not a throw', () => {
    expect(() => removeListingByUrl('https://example.com/never-added')).not.toThrow();
  });

  it('clearListings empties both maps', () => {
    addListingItem(
      makeListingItem({ data: { ...makeListingItem().data, url: 'https://example.com/a' } })
    );
    addListingItem(
      makeListingItem({ data: { ...makeListingItem().data, url: 'https://example.com/b' } })
    );

    clearListings();

    expect(listingsByUrl.size).toBe(0);
    expect(listingUrlByDedupeKey.size).toBe(0);
  });

  it('resetState clears listingUrlByDedupeKey along with listingsByUrl', () => {
    addListingItem(makeListingItem());

    resetState();

    expect(listingsByUrl.size).toBe(0);
    expect(listingUrlByDedupeKey.size).toBe(0);
  });
});

describe('isCardSearchActive', () => {
  it('returns true when searching', () => {
    expect(isCardSearchActive('searching')).toBe(true);
  });

  it('returns true when cancelling', () => {
    expect(isCardSearchActive('cancelling')).toBe(true);
  });

  it('returns false when idle', () => {
    expect(isCardSearchActive('idle')).toBe(false);
  });

  it('returns false when done', () => {
    expect(isCardSearchActive('done')).toBe(false);
  });
});
