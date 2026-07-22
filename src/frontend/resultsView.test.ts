// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireChild } from './domUtils';
import {
  applyClientFilters,
  applySortOrder,
  getCardByUrl,
  getOrderedListings,
  renderCard,
  renderDerived,
  scheduleSortOrderUpdate,
} from './resultsView';
import { populateShowControls } from './showDropdown';
import * as sortListingsModule from './sortListings';
import {
  type ListingItem,
  listingsByUrl,
  resetState,
  setIsAiFilterRunning,
  setListingCategoryVisible,
  setSortBy,
  type UrlCardData,
} from './state';
import { makeListing, makeListingItem } from './testFixtures';
import { addUrlCard, resetUrlCardStore, type UrlCardDom } from './urlCardStore';

function makeListingItemAt(url: string): ListingItem {
  return makeListingItem({ data: makeListing({ url, title: url, price: null, location: '' }) });
}

function setAiFilterReason(url: string, reason: string): void {
  (listingsByUrl.get(url) as ListingItem).aiFilterReason = reason;
}

// Stubs window.matchMedia, which jsdom doesn't implement, so tests can
// exercise the mobile full-screen-sheet branch of renderAiFilterButton
// without a real viewport. Mirrors dropdownPanel.test.ts's helper of the same
// name.
function stubMobileMatchMedia(matches: boolean): () => void {
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  return () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  };
}

function addCardWithListings(listingUrls: string[]): void {
  const data: UrlCardData = {
    searchStatus: 'done',
    searchedUrl: '',
    searchId: null,
    listingUrls,
    lastProgress: null,
    errorMessage: null,
    wasCancelled: false,
    isEditing: false,
  };
  addUrlCard({ input: document.createElement('textarea') } as UrlCardDom, data);
  for (const url of listingUrls) {
    if (!listingsByUrl.has(url)) listingsByUrl.set(url, makeListingItemAt(url));
  }
}

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  document.body.innerHTML = `
    <button id="deepBtn"></button>
    <textarea id="aiFilter"></textarea>
    <button id="aiFilterBtn"></button>
    <div id="listingsContainer"></div>
    <div id="showDropdown"></div>
  `;
  populateShowControls();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getOrderedListings', () => {
  it('preserves card order and dedupes cross-card listings', () => {
    addCardWithListings(['https://l/1', 'https://l/2']);
    addCardWithListings(['https://l/2', 'https://l/3']);
    const orderedUrls = getOrderedListings().map((item) => item.data.url);
    expect(orderedUrls).toEqual(['https://l/1', 'https://l/2', 'https://l/3']);
  });

  it('skips listing urls with no entry in listingsByUrl', () => {
    addCardWithListings(['https://l/1']);
    listingsByUrl.delete('https://l/1');
    expect(getOrderedListings()).toEqual([]);
  });
});

describe('renderDerived', () => {
  it('counts only passing listings as visible when filtered listings are hidden', () => {
    addCardWithListings(['https://l/1', 'https://l/2']);
    setAiFilterReason('https://l/2', 'too old');
    setListingCategoryVisible('filtered', false);
    renderDerived();
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('1 of 2 results');
  });

  it('counts all listings as visible when filtered listings are shown', () => {
    addCardWithListings(['https://l/1', 'https://l/2']);
    setAiFilterReason('https://l/2', 'too old');
    setListingCategoryVisible('filtered', true);
    renderDerived();
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('2 of 2 results');
  });

  it('refreshes the Show dropdown per-category counts', () => {
    addCardWithListings(['https://l/1', 'https://l/2']);
    setAiFilterReason('https://l/2', 'too old');
    renderDerived();
    expect(document.getElementById('showUsedCount')?.textContent).toBe('(1)');
    expect(document.getElementById('showFilteredCount')?.textContent).toBe('(1)');
  });

  it('visually disables (but keeps clickable) the ai-filter button when the prompt is blank', () => {
    addCardWithListings(['https://l/1', 'https://l/2']);
    renderDerived();
    const filterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
    // Not the native `disabled` attribute: on the mobile full-screen sheet
    // this button is also the sheet's sole dismiss control, so it must stay
    // clickable even with a blank prompt — see renderAiFilterButton.
    expect(filterBtn.disabled).toBe(false);
    expect(filterBtn.getAttribute('aria-disabled')).toBe('true');
    expect(filterBtn.textContent).toBe('Filter');
  });

  it('enables the ai-filter button once a prompt is entered', () => {
    addCardWithListings(['https://l/1', 'https://l/2']);
    (document.getElementById('aiFilter') as HTMLTextAreaElement).value = 'not a bike';
    renderDerived();
    const filterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
    expect(filterBtn.disabled).toBe(false);
    expect(filterBtn.hasAttribute('aria-disabled')).toBe(false);
  });

  it('shows a spinner and disables the ai-filter button while the ai filter is running', () => {
    addCardWithListings(['https://l/1']);
    (document.getElementById('aiFilter') as HTMLTextAreaElement).value = 'not a bike';
    setIsAiFilterRunning(true);
    renderDerived();
    const filterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
    expect(filterBtn.disabled).toBe(true);
    expect(filterBtn.querySelector('.spinner')).not.toBeNull();
    expect(filterBtn.textContent).toContain('Filtering..');
  });

  it('keeps the same spinner element across repeated renders while the ai filter is running', () => {
    addCardWithListings(['https://l/1']);
    (document.getElementById('aiFilter') as HTMLTextAreaElement).value = 'not a bike';
    setIsAiFilterRunning(true);
    renderDerived();
    const filterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
    const spinnerElement = filterBtn.querySelector('.spinner');
    renderDerived();
    // Recreating the spinner node restarts its CSS animation mid-run, so a
    // repeated render in the same state must leave the existing node in place.
    expect(filterBtn.querySelector('.spinner')).toBe(spinnerElement);
  });

  it('re-enables the ai-filter button and restores its label once the run finishes', () => {
    addCardWithListings(['https://l/1', 'https://l/2']);
    (document.getElementById('aiFilter') as HTMLTextAreaElement).value = 'not a bike';
    setIsAiFilterRunning(true);
    renderDerived();
    setIsAiFilterRunning(false);
    renderDerived();
    const filterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
    expect(filterBtn.disabled).toBe(false);
    expect(filterBtn.textContent).toBe('Filter');
  });

  it('shows a live pass/total count on the mobile full-screen sheet instead of "Filter"', () => {
    const restore = stubMobileMatchMedia(true);
    addCardWithListings(['https://l/1', 'https://l/2']);
    setAiFilterReason('https://l/2', 'too old');
    (document.getElementById('aiFilter') as HTMLTextAreaElement).value = 'not a bike';
    renderDerived();
    const filterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
    expect(filterBtn.textContent).toBe('Filtering 1 / 2 results');
    restore();
  });

  it('keeps the desktop "Filter"/"Filtering.." label when the mobile breakpoint is not active', () => {
    const restore = stubMobileMatchMedia(false);
    addCardWithListings(['https://l/1', 'https://l/2']);
    setAiFilterReason('https://l/2', 'too old');
    renderDerived();
    const filterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
    expect(filterBtn.textContent).toBe('Filter');
    restore();
  });

  it('updates the mobile pass/total count on repeated renders without recreating the spinner', () => {
    const restore = stubMobileMatchMedia(true);
    addCardWithListings(['https://l/1', 'https://l/2']);
    (document.getElementById('aiFilter') as HTMLTextAreaElement).value = 'not a bike';
    setIsAiFilterRunning(true);
    renderDerived();
    const filterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
    const spinnerElement = filterBtn.querySelector('.spinner');
    expect(filterBtn.textContent).toBe('Filtering 2 / 2 results');
    setAiFilterReason('https://l/2', 'too old');
    renderDerived();
    expect(filterBtn.textContent).toBe('Filtering 1 / 2 results');
    expect(filterBtn.querySelector('.spinner')).toBe(spinnerElement);
    restore();
  });

  it('builds the ordered listing list only once per render tick', () => {
    const urls = ['https://l/1', 'https://l/2', 'https://l/3'];
    addCardWithListings(urls);
    const getListingByUrlSpy = vi.spyOn(listingsByUrl, 'get');
    renderDerived();
    // getOrderedListings() looks up every url in listingsByUrl exactly once;
    // if renderDerived's sort step recomputes the ordered list independently
    // (rather than reusing the list renderDerived already built), this count
    // doubles to 2 * urls.length.
    expect(getListingByUrlSpy).toHaveBeenCalledTimes(urls.length);
  });
});

describe('applySortOrder', () => {
  const urls = ['https://l/1', 'https://l/2', 'https://l/3'];

  function renderAllCards(): void {
    for (const url of urls) renderCard(listingsByUrl.get(url) as ListingItem);
  }

  // Cards are reordered by moving DOM nodes (appendChild), not by writing
  // style.order, so tab order and screen-reader reading order match the
  // visual sort. This reads container child order directly rather than
  // any style property.
  function containerCardUrls(): (string | undefined)[] {
    const container = document.getElementById('listingsContainer') as HTMLElement;
    return [...container.children].map((child) => (child as HTMLElement).dataset.url);
  }

  it('is a no-op for the default source-url sort, since insertion order already matches', () => {
    addCardWithListings(urls);
    renderAllCards();
    applySortOrder(getOrderedListings());
    // DOM order is left untouched — it already matches source-url order from
    // insertion — rather than doing a needless sort + re-append.
    expect(containerCardUrls()).toEqual(urls);
  });

  it('skips card lookups and DOM writes entirely for the default source-url sort', () => {
    addCardWithListings(urls);
    renderAllCards();
    const getByIdSpy = vi.spyOn(document, 'getElementById');
    applySortOrder(getOrderedListings());
    expect(getByIdSpy).not.toHaveBeenCalled();
  });

  it('still performs card lookups and DOM writes for a non-default sort that actually reorders', () => {
    addCardWithListings(urls);
    renderAllCards();
    (listingsByUrl.get('https://l/1') as ListingItem).data.relevance = 2;
    (listingsByUrl.get('https://l/2') as ListingItem).data.relevance = 9;
    (listingsByUrl.get('https://l/3') as ListingItem).data.relevance = 5;
    setSortBy('best-match');
    const getByIdSpy = vi.spyOn(document, 'getElementById');
    applySortOrder(getOrderedListings());
    // One lookup per card, plus one for the listingsContainer itself.
    expect(getByIdSpy).toHaveBeenCalledTimes(urls.length + 1);
  });

  it('orders cards by relevance descending for best-match', () => {
    addCardWithListings(urls);
    renderAllCards();
    (listingsByUrl.get('https://l/1') as ListingItem).data.relevance = 2;
    (listingsByUrl.get('https://l/2') as ListingItem).data.relevance = 9;
    (listingsByUrl.get('https://l/3') as ListingItem).data.relevance = 5;
    setSortBy('best-match');
    applySortOrder(getOrderedListings());
    // DOM order (container.children), not just visual order, must match the
    // sort — this is what keeps keyboard tab order and screen-reader reading
    // order in sync with what's shown on screen.
    expect(containerCardUrls()).toEqual(['https://l/2', 'https://l/3', 'https://l/1']);
  });

  it('re-applies sort order as part of renderDerived, once the scheduled frame fires', () => {
    vi.useFakeTimers();
    try {
      addCardWithListings(urls);
      renderAllCards();
      (listingsByUrl.get('https://l/1') as ListingItem).data.price = 30;
      (listingsByUrl.get('https://l/2') as ListingItem).data.price = 10;
      (listingsByUrl.get('https://l/3') as ListingItem).data.price = 20;
      setSortBy('lowest-price');
      renderDerived();
      // Not applied synchronously — it's scheduled for the next frame.
      expect(containerCardUrls()).toEqual(urls);
      vi.advanceTimersByTime(20);
      expect(containerCardUrls()).toEqual(['https://l/2', 'https://l/3', 'https://l/1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Regression coverage for the SSE hot-path cost of sorting: scheduleSortOrderUpdate
// fires once per streamed listing, so the "would this reorder anything" check
// must stay cheap for the common case, and any real sort must never be
// recomputed within the same call.
describe('sort call efficiency (SSE hot-path regression coverage)', () => {
  const urls = ['https://l/1', 'https://l/2', 'https://l/3'];

  function renderAllCards(): void {
    for (const url of urls) renderCard(listingsByUrl.get(url) as ListingItem);
  }

  it('never calls sortListings for the default sort with a single source', () => {
    addCardWithListings(urls);
    renderAllCards();
    const sortSpy = vi.spyOn(sortListingsModule, 'sortListings');
    applySortOrder(getOrderedListings());
    scheduleSortOrderUpdate(getOrderedListings());
    expect(sortSpy).not.toHaveBeenCalled();
  });

  it('calls sortListings exactly once per applySortOrder call when a reorder is actually needed', () => {
    addCardWithListings(urls);
    renderAllCards();
    (listingsByUrl.get('https://l/1') as ListingItem).data.relevance = 2;
    (listingsByUrl.get('https://l/2') as ListingItem).data.relevance = 9;
    (listingsByUrl.get('https://l/3') as ListingItem).data.relevance = 5;
    setSortBy('best-match');
    const sortSpy = vi.spyOn(sortListingsModule, 'sortListings');
    applySortOrder(getOrderedListings());
    expect(sortSpy).toHaveBeenCalledTimes(1);
  });

  it('calls sortListings exactly once when the default sort has mixed sources', () => {
    const listings = [
      makeListingItem({ data: makeListing({ url: 'https://l/1', source: 'facebook' }) }),
      makeListingItem({ data: makeListing({ url: 'https://l/2', source: 'trademe' }) }),
    ];
    const sortSpy = vi.spyOn(sortListingsModule, 'sortListings');
    applySortOrder(listings);
    expect(sortSpy).toHaveBeenCalledTimes(1);
  });

  it('does not treat trademe and trademe-expired as mixed sources', () => {
    const listings = [
      makeListingItem({ data: makeListing({ url: 'https://l/1', source: 'trademe-expired' }) }),
      makeListingItem({ data: makeListing({ url: 'https://l/2', source: 'trademe' }) }),
    ];
    const sortSpy = vi.spyOn(sortListingsModule, 'sortListings');
    applySortOrder(listings);
    expect(sortSpy).not.toHaveBeenCalled();
  });
});

describe('scheduleSortOrderUpdate', () => {
  const urls = ['https://l/1', 'https://l/2', 'https://l/3'];

  function renderAllCards(): void {
    for (const url of urls) renderCard(listingsByUrl.get(url) as ListingItem);
  }

  function containerCardUrls(): (string | undefined)[] {
    const container = document.getElementById('listingsContainer') as HTMLElement;
    return [...container.children].map((child) => (child as HTMLElement).dataset.url);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule an animation frame for the default source-url sort', () => {
    addCardWithListings(urls);
    renderAllCards();
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    scheduleSortOrderUpdate(getOrderedListings());
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('coalesces a burst of rapid calls during streaming into a single sort/reorder using the last snapshot', () => {
    addCardWithListings(urls);
    renderAllCards();
    setSortBy('lowest-price');
    const getByIdSpy = vi.spyOn(document, 'getElementById');

    // Simulate several SSE "listing" events landing within the same frame,
    // each with a progressively updated price and listing snapshot.
    (listingsByUrl.get('https://l/1') as ListingItem).data.price = 30;
    (listingsByUrl.get('https://l/2') as ListingItem).data.price = 20;
    (listingsByUrl.get('https://l/3') as ListingItem).data.price = 10;
    scheduleSortOrderUpdate(getOrderedListings());

    (listingsByUrl.get('https://l/1') as ListingItem).data.price = 10;
    (listingsByUrl.get('https://l/2') as ListingItem).data.price = 20;
    (listingsByUrl.get('https://l/3') as ListingItem).data.price = 30;
    scheduleSortOrderUpdate(getOrderedListings());

    (listingsByUrl.get('https://l/1') as ListingItem).data.price = 20;
    (listingsByUrl.get('https://l/2') as ListingItem).data.price = 30;
    (listingsByUrl.get('https://l/3') as ListingItem).data.price = 10;
    scheduleSortOrderUpdate(getOrderedListings());

    // Nothing runs synchronously — the sort/reorder is deferred.
    expect(getByIdSpy).not.toHaveBeenCalled();
    expect(containerCardUrls()).toEqual(urls);
    getByIdSpy.mockClear();

    vi.advanceTimersByTime(20);

    // Exactly one lookup per card, plus one for the container — proving the
    // sort/reorder ran once, not three times.
    expect(getByIdSpy).toHaveBeenCalledTimes(urls.length + 1);
    // And it used the last-scheduled snapshot: l/3 has the lowest price.
    expect(containerCardUrls()).toEqual(['https://l/3', 'https://l/1', 'https://l/2']);
  });

  it('only requests a single animation frame for a burst of calls', () => {
    addCardWithListings(urls);
    renderAllCards();
    (listingsByUrl.get('https://l/1') as ListingItem).data.price = 30;
    (listingsByUrl.get('https://l/2') as ListingItem).data.price = 20;
    (listingsByUrl.get('https://l/3') as ListingItem).data.price = 10;
    setSortBy('lowest-price');
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

    scheduleSortOrderUpdate(getOrderedListings());
    scheduleSortOrderUpdate(getOrderedListings());
    scheduleSortOrderUpdate(getOrderedListings());

    expect(rafSpy).toHaveBeenCalledTimes(1);
  });
});

describe('renderCard', () => {
  // Regression coverage: the external-link button must not be a descendant
  // of .listing-open-area (which gets role="button"/tabindex from
  // applyListingCardAccessibility) — a focusable <a> nested inside another
  // interactive control is an invalid ARIA content model.
  it('renders the external-link button outside .listing-open-area', () => {
    renderCard(makeListingItemAt('https://l/1'));
    const card = requireChild<HTMLElement>(document.body, '.listing-card');
    const openArea = requireChild<HTMLElement>(card, '.listing-open-area');
    expect(openArea.querySelector('.listing-external-link-btn')).toBeNull();
    expect(card.querySelector('.listing-external-link-btn')).not.toBeNull();
  });

  it('shows the sold banner and sold class for a sold listing', () => {
    renderCard(makeListingItem({ data: makeListing({ url: 'https://l/1', isSold: true }) }));
    const card = requireChild<HTMLElement>(document.body, '.listing-card');
    expect(card.classList.contains('sold')).toBe(true);
    const banner = requireChild<HTMLElement>(card, '.sold-banner');
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(banner.textContent).toBe('SOLD');
  });

  it('hides the sold banner and omits the sold class for a non-sold listing', () => {
    renderCard(makeListingItemAt('https://l/1'));
    const card = requireChild<HTMLElement>(document.body, '.listing-card');
    expect(card.classList.contains('sold')).toBe(false);
    const banner = requireChild<HTMLElement>(card, '.sold-banner');
    expect(banner.classList.contains('hidden')).toBe(true);
  });
});

describe('applyClientFilters', () => {
  function renderListing(url: string, overrides: Partial<ListingItem> = {}): void {
    const item = makeListingItem({
      data: makeListing({ url, title: url, price: null, location: '' }),
      ...overrides,
    });
    listingsByUrl.set(url, item);
    addCardWithListings([url]);
    renderCard(item);
  }

  it('hides sold listings when "sold" is removed from visibleListingCategories', () => {
    renderListing('https://l/1', { data: makeListing({ url: 'https://l/1', isSold: true }) });
    setListingCategoryVisible('sold', false);
    applyClientFilters();
    expect((getCardByUrl('https://l/1') as HTMLElement).style.display).toBe('none');
  });

  it('hides filtered listings when "filtered" is removed', () => {
    renderListing('https://l/1', { aiFilterReason: 'too old' });
    setListingCategoryVisible('filtered', false);
    applyClientFilters();
    expect((getCardByUrl('https://l/1') as HTMLElement).style.display).toBe('none');
  });

  it('hides used listings when "used" is removed', () => {
    renderListing('https://l/1');
    setListingCategoryVisible('used', false);
    applyClientFilters();
    expect((getCardByUrl('https://l/1') as HTMLElement).style.display).toBe('none');
  });

  it('restores display when the category is re-added', () => {
    renderListing('https://l/1', { aiFilterReason: 'too old' });
    setListingCategoryVisible('filtered', false);
    applyClientFilters();
    setListingCategoryVisible('filtered', true);
    applyClientFilters();
    expect((getCardByUrl('https://l/1') as HTMLElement).style.display).toBe('');
  });

  it('does not hide a sold listing when only "filtered" is removed', () => {
    renderListing('https://l/1', { data: makeListing({ url: 'https://l/1', isSold: true }) });
    setListingCategoryVisible('filtered', false);
    applyClientFilters();
    expect((getCardByUrl('https://l/1') as HTMLElement).style.display).toBe('');
  });
});
