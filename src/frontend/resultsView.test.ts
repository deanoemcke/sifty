// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireChild } from './domUtils';
import { djb2Hash } from './renderUtils';
import {
  applyClientFilters,
  applySortOrder,
  getCardByUrl,
  getOrderedListings,
  renderCard,
  renderDerived,
  resetFrameMutationSchedulingForTests,
  scheduleClientFilterUpdate,
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
  // Clears any card-reveal/filter-sweep flush left armed by the previous
  // test, rather than relying on every test remembering to flush it before
  // ending (see resetFrameMutationSchedulingForTests's own comment in
  // resultsView.ts). scheduleSortOrderUpdate uses a separate rafSchedule
  // instance not covered by this reset — the fake timers below (always
  // flushed in afterEach) are what keep that one from leaking instead, plus
  // let tests exercise coalescing behaviour with vi.advanceTimersByTime.
  resetFrameMutationSchedulingForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
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

  // Regression coverage: the placeholder icon must be sized by CSS
  // (percentage of its container), not by hardcoded SVG width/height
  // attributes — otherwise it stays a fixed pixel size regardless of how
  // large the card's thumbnail area actually is.
  it('renders a scalable placeholder icon for a listing with no thumbnail', () => {
    renderCard(makeListingItemAt('https://l/1'));
    const card = requireChild<HTMLElement>(document.body, '.listing-card');
    expect(card.querySelector('.listing-thumb')).toBeNull();
    const placeholder = requireChild<HTMLElement>(card, '.listing-thumb-placeholder');
    const icon = requireChild<SVGElement>(placeholder, 'svg');
    expect(icon.hasAttribute('width')).toBe(false);
    expect(icon.hasAttribute('height')).toBe(false);
    expect(icon.classList.contains('listing-thumb-placeholder-icon')).toBe(true);
  });

  // Regression coverage: a single requestAnimationFrame fires before the
  // browser has ever painted the just-appended card's opacity:0 'entering'
  // state (nothing has been painted since it was inserted this same tick).
  // Removing 'entering' inside that first frame skips straight to opacity:1
  // with no visible fade — the CSS transition never gets a starting frame to
  // animate from. A second, nested frame gives the browser one paint of the
  // hidden state first.
  it('keeps the entering class through the first animation frame, only revealing on the second', () => {
    renderCard(makeListingItemAt('https://l/1'));
    const card = requireChild<HTMLElement>(document.body, '.listing-card');
    expect(card.classList.contains('entering')).toBe(true);

    vi.advanceTimersByTime(20);
    expect(card.classList.contains('entering')).toBe(true);

    vi.advanceTimersByTime(20);
    expect(card.classList.contains('entering')).toBe(false);
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

  function setAiFilterPrompt(value: string): void {
    (document.getElementById('aiFilter') as HTMLTextAreaElement).value = value;
  }

  it('marks a card as ai-scanning when the AI filter prompt does not match its aiCheckedHash', () => {
    renderListing('https://l/1');
    setAiFilterPrompt('bikes');
    applyClientFilters();
    expect((getCardByUrl('https://l/1') as HTMLElement).classList.contains('ai-scanning')).toBe(
      true
    );
  });

  it('does not mark a card as ai-scanning when the AI filter prompt is empty', () => {
    renderListing('https://l/1');
    setAiFilterPrompt('');
    applyClientFilters();
    expect((getCardByUrl('https://l/1') as HTMLElement).classList.contains('ai-scanning')).toBe(
      false
    );
  });

  it('does not mark a card as ai-scanning once its aiCheckedHash matches the current prompt', () => {
    renderListing('https://l/1', { aiCheckedHash: djb2Hash('bikes') });
    setAiFilterPrompt('bikes');
    applyClientFilters();
    expect((getCardByUrl('https://l/1') as HTMLElement).classList.contains('ai-scanning')).toBe(
      false
    );
  });

  // Regression coverage: the sheen used to be driven by a Set the currently
  // in-flight run's toCheck list populated, so a card that streamed in
  // outside of any run (e.g. from a second URL card's search finishing after
  // the AI filter already started once) never got marked pending at all.
  // Deriving straight from aiCheckedHash vs. the prompt's hash means no run
  // needs to be active — "not yet checked against the current criteria" is
  // true or false independent of whether a request happens to be in flight.
  it('marks a card as ai-scanning even when no AI filter run is currently active', () => {
    renderListing('https://l/1');
    setAiFilterPrompt('bikes');
    setIsAiFilterRunning(false);
    applyClientFilters();
    expect((getCardByUrl('https://l/1') as HTMLElement).classList.contains('ai-scanning')).toBe(
      true
    );
  });

  it('shows ai-scanning only on the not-yet-checked sibling when one card already matches the prompt', () => {
    renderListing('https://l/1', { aiCheckedHash: djb2Hash('bikes') });
    renderListing('https://l/2');
    setAiFilterPrompt('bikes');
    applyClientFilters();

    expect((getCardByUrl('https://l/1') as HTMLElement).classList.contains('ai-scanning')).toBe(
      false
    );
    expect((getCardByUrl('https://l/2') as HTMLElement).classList.contains('ai-scanning')).toBe(
      true
    );
  });
});

// Regression coverage for the SSE hot-path cost of applyClientFilters(): a
// 'listing' event fires once per streamed result, so calling
// applyClientFilters() (a full-list DOM sweep) directly from that handler is
// O(n) work per event, O(n^2) over a stream of n listings. scheduleClientFilterUpdate()
// coalesces a burst of calls into a single sweep per animation frame, mirroring
// scheduleSortOrderUpdate's existing pattern above.
describe('scheduleClientFilterUpdate', () => {
  function renderListing(url: string, overrides: Partial<ListingItem> = {}): void {
    const item = makeListingItem({
      data: makeListing({ url, title: url, price: null, location: '' }),
      ...overrides,
    });
    listingsByUrl.set(url, item);
    addCardWithListings([url]);
    renderCard(item);
  }

  it('does not apply the filter synchronously — only once the next frame fires', () => {
    renderListing('https://l/1');
    setListingCategoryVisible('used', false);

    scheduleClientFilterUpdate();
    expect((getCardByUrl('https://l/1') as HTMLElement).style.display).toBe('');

    vi.advanceTimersByTime(20);
    expect((getCardByUrl('https://l/1') as HTMLElement).style.display).toBe('none');
  });

  it('costs the same DOM work whether triggered once or by a burst of calls before the frame fires', () => {
    renderListing('https://l/1');
    renderListing('https://l/2');
    renderListing('https://l/3');

    // Baseline: the DOM cost of a single direct sweep.
    const baselineSpy = vi.spyOn(document, 'getElementById');
    applyClientFilters();
    const singleSweepCost = baselineSpy.mock.calls.length;
    baselineSpy.mockRestore();

    // A burst of scheduled calls — simulating several listings streaming in
    // within the same animation frame — must cost the same as a single
    // sweep, not once per call (which would be the O(n^2) regression).
    const burstSpy = vi.spyOn(document, 'getElementById');
    scheduleClientFilterUpdate();
    scheduleClientFilterUpdate();
    scheduleClientFilterUpdate();
    vi.advanceTimersByTime(20);

    expect(burstSpy).toHaveBeenCalledTimes(singleSweepCost);
  });

  it('only requests a single animation frame for a burst of calls', () => {
    // renderListing() itself schedules a frame (renderCard()'s card-reveal
    // scheduling shares scheduleClientFilterUpdate()'s flush — see
    // resultsView.ts's scheduleFrameMutationFlush). Flush that one first so
    // the spy below only observes the calls this test is actually about.
    renderListing('https://l/1');
    vi.advanceTimersByTime(20);

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

    scheduleClientFilterUpdate();
    scheduleClientFilterUpdate();
    scheduleClientFilterUpdate();

    expect(rafSpy).toHaveBeenCalledTimes(1);
  });
});

// Regression coverage: a streamed 'listing' SSE event calls renderCard()
// (which schedules the new card's entering->revealed fade) and
// scheduleClientFilterUpdate() (which schedules a filter sweep) in the same
// synchronous tick, so both land in the same animation frame. They share one
// rafSchedule-coalesced flush (pendingFrameMutations/flushFrameMutations in
// resultsView.ts) rather than each independently scheduling its own frame,
// so a fast burst never redoes the O(n) filter sweep more than once per
// frame.
describe('frame mutation coalescing (single flush per frame)', () => {
  it('coalesces a same-frame card reveal and filter sweep into a single animation frame', () => {
    const item = makeListingItemAt('https://l/1');
    listingsByUrl.set('https://l/1', item);
    addCardWithListings(['https://l/1']);

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

    renderCard(item);
    setListingCategoryVisible('used', false);
    scheduleClientFilterUpdate();

    expect(rafSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20);

    const card = getCardByUrl('https://l/1') as HTMLElement;
    // The filter sweep applies within this first frame...
    expect(card.style.display).toBe('none');
    // ...but the reveal itself waits one more frame (see renderCard's
    // describe block above) so the browser paints the entering state first.
    expect(card.classList.contains('entering')).toBe(true);

    vi.advanceTimersByTime(20);
    expect(card.classList.contains('entering')).toBe(false);
  });

  it('does not redo the filter sweep when an already-scheduled frame fires after a synchronous applyClientFilters call absorbed it', () => {
    const item = makeListingItemAt('https://l/1');
    listingsByUrl.set('https://l/1', item);
    addCardWithListings(['https://l/1']);

    renderCard(item);
    vi.advanceTimersByTime(40); // let the card's own two-frame reveal fully resolve first

    scheduleClientFilterUpdate(); // arms a fresh frame for the filter sweep only
    applyClientFilters(); // absorbs it synchronously, clearing the pending flag

    const staleFrameSpy = vi.spyOn(document, 'getElementById');
    vi.advanceTimersByTime(20); // the now-stale scheduled frame fires and must no-op

    expect(staleFrameSpy).not.toHaveBeenCalled();
  });

  // Regression coverage for the bug the fix in flushFrameMutations() addresses:
  // a synchronous applyClientFilters() call landing before the frame that
  // scheduleCardRevealOnNextFrame() armed has fired must not shortcut the
  // reveal to a single level of rAF deferral — see renderCard's describe
  // block above for why a single frame isn't enough. quickSearch.ts calling
  // applyClientFilters() directly right after the last renderCard() of a
  // completed search (the common real-world path) is exactly this scenario.
  it('keeps the entering class deferred through two frames even when a synchronous applyClientFilters call absorbs the pending reveal', () => {
    const item = makeListingItemAt('https://l/1');
    listingsByUrl.set('https://l/1', item);
    addCardWithListings(['https://l/1']);

    renderCard(item); // schedules a frame for the card reveal
    applyClientFilters(); // synchronous call lands before that frame fires

    const card = getCardByUrl('https://l/1') as HTMLElement;
    // Must not have revealed early just because a synchronous call intervened.
    expect(card.classList.contains('entering')).toBe(true);

    vi.advanceTimersByTime(20); // the originally-armed frame fires
    expect(card.classList.contains('entering')).toBe(true); // still deferred one more frame

    vi.advanceTimersByTime(20); // second frame: now actually revealed
    expect(card.classList.contains('entering')).toBe(false);
  });
});
