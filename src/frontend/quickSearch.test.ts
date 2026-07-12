// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing } from '../lib/recipes/base';
import {
  isNewConditionSearchUrl,
  normalizeListingRelevance,
  searchUrlCardAsync,
} from './quickSearch';
import { cardStatusText } from './searchStatusText';
import { populateShowControls } from './showDropdown';
import { listingsByUrl, listingUrlByDedupeKey, resetState, type UrlCardData } from './state';
import { cancelSearch, cardStatusSnapshot } from './urlCardRow';
import {
  addUrlCard,
  resetUrlCardStore,
  type UrlCard,
  type UrlCardDom,
  urlCardData,
} from './urlCardStore';

const TRADEME_URL = 'https://www.trademe.co.nz/search/test';

function makeCardData(): UrlCardData {
  return {
    searchStatus: 'idle',
    searchedUrl: '',
    searchId: null,
    listingUrls: [],
    lastProgress: null,
    errorMessage: null,
    wasCancelled: false,
  };
}

function makeCardDom(url: string): UrlCardDom {
  const criteriaElement = document.createElement('div');
  criteriaElement.innerHTML = '<div class="criteria-grid"></div>';
  const input = document.createElement('input');
  input.value = url;
  return {
    containerElement: document.createElement('div'),
    input,
    linkElement: document.createElement('a'),
    searchButton: document.createElement('button'),
    removeButton: document.createElement('button'),
    criteriaElement,
    cacheStatusElement: document.createElement('div'),
    statusElement: document.createElement('div'),
  };
}

// Stubs the fetch call `streamPostAsync` makes, streaming one line per chunk
// so each is processed on its own tick — matching how a real SSE response
// interleaves with other async work (e.g. a cancel-button click) between reads.
// `onBeforeRead` runs before each `read()` settles, keyed by call index.
function stubQuickSearchStream(chunks: string[], onBeforeRead?: (callIndex: number) => void): void {
  const encoder = new TextEncoder();
  const pendingChunks = [...chunks];
  let callIndex = 0;
  const reader = {
    read: async () => {
      onBeforeRead?.(callIndex);
      callIndex += 1;
      return pendingChunks.length > 0
        ? { value: encoder.encode(pendingChunks.shift()), done: false }
        : { value: undefined, done: true };
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: { getReader: () => reader },
    })
  );
}

function addSearchableCard(): UrlCard {
  return addUrlCard(makeCardDom(TRADEME_URL), makeCardData());
}

function addSearchableCardWithUrl(url: string): UrlCard {
  return addUrlCard(makeCardDom(url), makeCardData());
}

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  document.body.innerHTML = `
    <div id="resultsSection" class="hidden"></div>
    <div id="urlCardsContainer"></div>
    <button id="deepBtn"></button>
    <textarea id="aiFilter"></textarea>
    <button id="aiFilterBtn"></button>
    <div id="showDropdown"></div>
  `;
  populateShowControls();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchUrlCardAsync — post-stream cancellation disambiguation', () => {
  it('marks the search cancelled when cancelSearch fires while the stream is still being read', async () => {
    const card = addSearchableCard();
    stubQuickSearchStream(['data: {"type":"progress","phase":"loading"}\n'], (callIndex) => {
      // Simulates the user clicking cancel in the gap between two network reads.
      if (callIndex === 1) cancelSearch(card);
    });

    await searchUrlCardAsync(card);

    const data = urlCardData(card);
    expect(data.searchStatus).toBe('idle');
    expect(data.wasCancelled).toBe(true);
    expect(cardStatusText(cardStatusSnapshot(card))).toEqual({
      text: 'Cancelled — 0 listings',
      kind: 'error',
    });
  });

  it('marks the search done, not cancelled, when the stream finishes without an intervening cancel', async () => {
    const card = addSearchableCard();
    stubQuickSearchStream(['data: {"type":"progress","phase":"loading"}\n']);

    await searchUrlCardAsync(card);

    const data = urlCardData(card);
    expect(data.searchStatus).toBe('done');
    expect(data.wasCancelled).toBe(false);
  });
});

describe('normalizeListingRelevance', () => {
  it('leaves an existing relevance untouched', () => {
    const listing = { url: 'a', relevance: 7 } as Listing;
    expect(normalizeListingRelevance(listing).relevance).toBe(7);
  });

  it('defaults relevance to 0 when absent, e.g. a pre-deploy cached row replayed via SSE', () => {
    // `JSON.parse(ev.data)` on a stale cache entry produces an object with no
    // `relevance` key — the `as Listing` cast lets it through undetected.
    const staleListing = { url: 'a' } as Listing;
    expect(staleListing.relevance).toBeUndefined();
    expect(normalizeListingRelevance(staleListing).relevance).toBe(0);
  });
});

describe('searchUrlCardAsync — content-based duplicate suppression', () => {
  it('does not add a second listing whose base URL, title, and location match one already seen', async () => {
    const card = addSearchableCard();
    stubQuickSearchStream([
      'data: {"type":"listing","data":{"source":"trademe","title":"Vintage lamp","price":10,"location":"Wellington","url":"https://example.com/listing/1?ref=facebook","isAuction":false}}\n',
      'data: {"type":"listing","data":{"source":"trademe","title":"Vintage lamp","price":10,"location":"Wellington","url":"https://example.com/listing/1?ref=trademe","isAuction":false}}\n',
    ]);

    await searchUrlCardAsync(card);

    expect(listingsByUrl.size).toBe(1);
    expect(listingsByUrl.has('https://example.com/listing/1?ref=facebook')).toBe(true);
    // The O(1) dedupe index (listingUrlByDedupeKey) must stay in lockstep
    // with listingsByUrl — it's what searchUrlCardAsync's isDuplicate check
    // actually reads, so a stale/missing entry here would let a real
    // duplicate re-appear as "new" on the next matching listing event.
    expect(listingUrlByDedupeKey.size).toBe(1);
  });

  it('still adds a second listing whose title differs, even with the same base URL', async () => {
    const card = addSearchableCard();
    stubQuickSearchStream([
      'data: {"type":"listing","data":{"source":"trademe","title":"Vintage lamp","price":10,"location":"Wellington","url":"https://example.com/listing/1?ref=facebook","isAuction":false}}\n',
      'data: {"type":"listing","data":{"source":"trademe","title":"Modern lamp","price":10,"location":"Wellington","url":"https://example.com/listing/1?ref=trademe","isAuction":false}}\n',
    ]);

    await searchUrlCardAsync(card);

    expect(listingsByUrl.size).toBe(2);
    expect(listingUrlByDedupeKey.size).toBe(2);
  });

  it('detects a duplicate arriving many listings later without rescanning stale keys', async () => {
    // Regression guard for the O(n)/O(n²) rescan this refactor replaces: the
    // duplicate below only matches the *first* listing seen, so a stale or
    // incomplete index (e.g. one that dropped earlier entries) would fail to
    // flag it as a duplicate.
    const card = addSearchableCard();
    const chunks = [
      'data: {"type":"listing","data":{"source":"trademe","title":"Vintage lamp","price":10,"location":"Wellington","url":"https://example.com/listing/1","isAuction":false}}\n',
    ];
    for (let i = 2; i <= 20; i++) {
      chunks.push(
        `data: {"type":"listing","data":{"source":"trademe","title":"Item ${i}","price":10,"location":"Wellington","url":"https://example.com/listing/${i}","isAuction":false}}\n`
      );
    }
    chunks.push(
      'data: {"type":"listing","data":{"source":"trademe","title":"Vintage lamp","price":10,"location":"Wellington","url":"https://example.com/listing/1?ref=other","isAuction":false}}\n'
    );
    stubQuickSearchStream(chunks);

    await searchUrlCardAsync(card);

    expect(listingsByUrl.size).toBe(20);
    expect(listingsByUrl.has('https://example.com/listing/1?ref=other')).toBe(false);
  });
});

describe('searchUrlCardAsync — stale cached listing data', () => {
  it('defaults relevance to 0 for a listing event replaying a pre-deploy cache row', async () => {
    const card = addSearchableCard();
    // Simulates the server replaying a row cached before `relevance` became
    // mandatory on `Listing` — the SSE payload simply omits the field.
    stubQuickSearchStream([
      'data: {"type":"cached","age":"5m"}\n',
      'data: {"type":"listing","data":{"source":"trademe","title":"t","price":10,"location":"","url":"https://example.com/stale","isAuction":false}}\n',
    ]);

    await searchUrlCardAsync(card);

    const item = listingsByUrl.get('https://example.com/stale');
    expect(item?.data.relevance).toBe(0);
  });
});

describe('isNewConditionSearchUrl', () => {
  it('returns true for a TradeMe URL with condition=new', () => {
    expect(
      isNewConditionSearchUrl('https://www.trademe.co.nz/a/marketplace/search?condition=new')
    ).toBe(true);
  });

  it('returns true for a Facebook URL with itemCondition=new', () => {
    expect(
      isNewConditionSearchUrl('https://www.facebook.com/marketplace/search?itemCondition=new')
    ).toBe(true);
  });

  it('returns false for a TradeMe URL with condition=used', () => {
    expect(
      isNewConditionSearchUrl('https://www.trademe.co.nz/a/marketplace/search?condition=used')
    ).toBe(false);
  });

  it('returns false for a URL with no condition param', () => {
    expect(isNewConditionSearchUrl(TRADEME_URL)).toBe(false);
  });

  it('returns false for an invalid URL', () => {
    expect(isNewConditionSearchUrl('not a url')).toBe(false);
  });
});

describe('searchUrlCardAsync — isNew tagging', () => {
  it('tags a listing isNew when its card URL has condition=new', async () => {
    const card = addSearchableCardWithUrl(
      'https://www.trademe.co.nz/a/marketplace/search?condition=new'
    );
    stubQuickSearchStream([
      'data: {"type":"listing","data":{"source":"trademe","title":"t","price":10,"location":"","url":"https://example.com/new-item","isAuction":false,"relevance":0}}\n',
    ]);

    await searchUrlCardAsync(card);

    const item = listingsByUrl.get('https://example.com/new-item');
    expect(item?.data.isNew).toBe(true);
  });

  it('leaves isNew unset for a listing from a card URL without condition=new', async () => {
    const card = addSearchableCard();
    stubQuickSearchStream([
      'data: {"type":"listing","data":{"source":"trademe","title":"t","price":10,"location":"","url":"https://example.com/normal-item","isAuction":false,"relevance":0}}\n',
    ]);

    await searchUrlCardAsync(card);

    const item = listingsByUrl.get('https://example.com/normal-item');
    expect(item?.data.isNew).toBeUndefined();
  });
});
