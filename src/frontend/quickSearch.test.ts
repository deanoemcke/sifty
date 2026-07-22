// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing } from '../lib/recipes/base';
import { getElement } from './domUtils';
import {
  clearQuickSearchCacheAsync,
  isNewConditionSearchUrl,
  normalizeListingRelevance,
  searchUrlCardAsync,
} from './quickSearch';
import { getCardByUrl } from './resultsView';
import { cardStatusText } from './searchStatusText';
import { populateShowControls } from './showDropdown';
import {
  listingsByUrl,
  listingUrlByDedupeKey,
  resetState,
  setListingCategoryVisible,
  type UrlCardData,
} from './state';
import { cancelSearch, cardStatusSnapshot, removeUrlCard } from './urlCardRow';
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
    isEditing: false,
  };
}

function makeCardDom(url: string): UrlCardDom {
  const criteriaElement = document.createElement('div');
  criteriaElement.innerHTML = '<div class="criteria-grid"></div>';
  const input = document.createElement('textarea');
  input.value = url;
  return {
    containerElement: document.createElement('div'),
    input,
    linkElement: document.createElement('a'),
    editButton: document.createElement('button'),
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
    <div id="listingsContainer"></div>
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

  // Regression test for the blur-vs-remove race: editing a card's URL fires
  // an autosearch on blur, and clicking the card's own Remove button right
  // after can remove the card while that search is still streaming.
  // removeUrlCard already cleans up listings the card found *before* it was
  // removed (see the "early-item" assertion below) — the bug is a listing
  // that streams in *after* removal, which that one-off cleanup pass can
  // never catch, leaking it into the shared grid with no card left to
  // remove it. Without the isUrlCardLive guard, "late-item" would be added
  // via addListingItem and never cleaned up.
  it('drops any listing event that arrives after the card has been removed mid-search, so nothing leaks into the shared results grid', async () => {
    const card = addSearchableCard();
    stubQuickSearchStream(
      [
        'data: {"type":"listing","data":{"source":"trademe","title":"t","price":10,"location":"","url":"https://example.com/early-item","isAuction":false,"relevance":0}}\n',
        'data: {"type":"listing","data":{"source":"trademe","title":"t2","price":20,"location":"","url":"https://example.com/late-item","isAuction":false,"relevance":0}}\n',
      ],
      (callIndex) => {
        // Simulates the remove button being clicked in the gap between two
        // network reads — after the first listing has already streamed in,
        // but before the second one arrives.
        if (callIndex === 1) removeUrlCard(card);
      }
    );

    await searchUrlCardAsync(card);

    // Removal's own cleanup already took the first listing back out again —
    // this just confirms that pass ran, it's not the regression under test.
    expect(listingsByUrl.has('https://example.com/early-item')).toBe(false);
    // The regression: this listing streamed in after removal, so it must
    // never have been added in the first place.
    expect(listingsByUrl.has('https://example.com/late-item')).toBe(false);
    expect(listingsByUrl.size).toBe(0);
  });
});

describe('searchUrlCardAsync — Show filter applied to in-flight listings', () => {
  // renderDerived() (called for every streamed listing) only recomputes the
  // Show dropdown's live count/label — applyClientFilters() is what actually
  // sets a card's display:none, and it previously only ran on a checkbox
  // change or once the whole card's stream finished. A listing that renders
  // in between those two points ignored the just-toggled filter entirely, so
  // the label read correctly while the card underneath stayed visible — most
  // visible on the mobile Show sheet, which hides the results grid while
  // this desync builds up and then reveals the stale state all at once.
  it('hides a listing that streams in after the "used" category was hidden mid-search, not just ones already on screen', async () => {
    const card = addSearchableCard();
    // Captured mid-stream, before the post-completion applyClientFilters()
    // call below would paper over the bug by re-syncing every card at the
    // very end — expect() can't be called directly inside onBeforeRead since
    // it runs inside the mocked reader.read(), which quickSearch.ts's own
    // try/catch around the stream would silently swallow as a search error.
    let midStreamLateDisplay: string | undefined;
    stubQuickSearchStream(
      [
        'data: {"type":"listing","data":{"source":"trademe","title":"Early","price":10,"location":"","url":"https://example.com/early","isAuction":false,"relevance":0}}\n',
        'data: {"type":"listing","data":{"source":"trademe","title":"Late","price":10,"location":"","url":"https://example.com/late","isAuction":false,"relevance":0}}\n',
      ],
      (callIndex) => {
        // Simulates unchecking "Used" in the Show dropdown in the gap
        // between two network reads — after "early" has already streamed in
        // and rendered, but before "late" arrives.
        if (callIndex === 1) setListingCategoryVisible('used', false);
        // By callIndex 2, "late" has already been read and processed (its
        // 'listing' event handler ran before this next read is requested),
        // but the stream hasn't finished yet.
        if (callIndex === 2) {
          midStreamLateDisplay = getCardByUrl('https://example.com/late')?.style.display;
        }
      }
    );

    await searchUrlCardAsync(card);

    expect(midStreamLateDisplay).toBe('none');
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

describe('clearQuickSearchCacheAsync', () => {
  // Routes fetch by URL: `/api/cache/clear` resolves like a plain POST, while
  // `/api/quick-search` is served from `researchChunks` — clearing the cache
  // now re-runs the card's search, so both endpoints get hit in one call.
  function stubClearThenResearch(researchChunks: string[]): Array<{ url: string; body: unknown }> {
    const calls: Array<{ url: string; body: unknown }> = [];
    const encoder = new TextEncoder();
    const pendingChunks = [...researchChunks];
    const reader = {
      read: async () =>
        pendingChunks.length > 0
          ? { value: encoder.encode(pendingChunks.shift()), done: false }
          : { value: undefined, done: true },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
        if (url === '/api/cache/clear') return Promise.resolve({ ok: true } as Response);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
          body: { getReader: () => reader },
        } as unknown as Response);
      })
    );
    return calls;
  }

  async function setUpCachedCard(url: string, listingUrl: string): Promise<UrlCard> {
    const card = addSearchableCardWithUrl(url);
    stubQuickSearchStream([
      'data: {"type":"cached","age":"5m"}\n',
      `data: {"type":"listing","data":{"source":"trademe","title":"t","price":10,"location":"","url":"${listingUrl}","isAuction":false,"relevance":0}}\n`,
    ]);
    await searchUrlCardAsync(card);
    return card;
  }

  it('posts { type: "quick-search", url: <searchedUrl> } to clear the cache, then re-runs the search against the same URL', async () => {
    const card = await setUpCachedCard(TRADEME_URL, 'https://example.com/item-a');
    const calls = stubClearThenResearch([
      'data: {"type":"listing","data":{"source":"trademe","title":"t2","price":20,"location":"","url":"https://example.com/item-b","isAuction":false,"relevance":0}}\n',
    ]);

    await clearQuickSearchCacheAsync(card);

    expect(calls[0].url).toBe('/api/cache/clear');
    expect(calls[0].body).toEqual({ type: 'quick-search', url: TRADEME_URL });
    expect(calls[1].url).toBe('/api/quick-search');
    expect((calls[1].body as { url: string }).url).toBe(TRADEME_URL);
  });

  it("clearing card A leaves card B's searchedUrl, listingUrls, and cache badge untouched", async () => {
    const cardA = await setUpCachedCard(
      'https://www.trademe.co.nz/search/a',
      'https://example.com/item-a'
    );
    const cardB = await setUpCachedCard(
      'https://www.trademe.co.nz/search/b',
      'https://example.com/item-b'
    );
    stubClearThenResearch([
      'data: {"type":"listing","data":{"source":"trademe","title":"t","price":10,"location":"","url":"https://example.com/item-a2","isAuction":false,"relevance":0}}\n',
    ]);

    await clearQuickSearchCacheAsync(cardA);

    const dataB = urlCardData(cardB);
    expect(dataB.searchedUrl).toBe('https://www.trademe.co.nz/search/b');
    expect(dataB.listingUrls).toEqual(['https://example.com/item-b']);
    expect(cardB.dom.cacheStatusElement.classList.contains('hidden')).toBe(false);
  });

  it('re-runs against fresh data — listingUrls reflect the new stream, and no stale cache badge remains', async () => {
    const card = await setUpCachedCard(TRADEME_URL, 'https://example.com/item-a');
    stubClearThenResearch([
      'data: {"type":"listing","data":{"source":"trademe","title":"t2","price":20,"location":"","url":"https://example.com/item-b","isAuction":false,"relevance":0}}\n',
    ]);

    await clearQuickSearchCacheAsync(card);

    const data = urlCardData(card);
    expect(data.searchStatus).toBe('done');
    expect(data.searchedUrl).toBe(TRADEME_URL);
    expect(data.listingUrls).toEqual(['https://example.com/item-b']);
    expect(card.dom.cacheStatusElement.classList.contains('hidden')).toBe(true);
    expect(card.dom.cacheStatusElement.innerHTML).toBe('');
  });

  it('surfaces the freshly streamed listing in listingsByUrl and keeps resultsSection visible', async () => {
    const card = await setUpCachedCard(TRADEME_URL, 'https://example.com/item-a');
    stubClearThenResearch([
      'data: {"type":"listing","data":{"source":"trademe","title":"t2","price":20,"location":"","url":"https://example.com/item-b","isAuction":false,"relevance":0}}\n',
    ]);

    await clearQuickSearchCacheAsync(card);

    expect(listingsByUrl.has('https://example.com/item-b')).toBe(true);
    expect(getElement('resultsSection').classList.contains('hidden')).toBe(false);
  });

  it('surfaces an error and does not re-search when the cache-clear request fails', async () => {
    const card = await setUpCachedCard(TRADEME_URL, 'https://example.com/item-a');
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push({ url });
        return Promise.resolve({ ok: false } as Response);
      })
    );

    await clearQuickSearchCacheAsync(card);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/cache/clear');
    const data = urlCardData(card);
    expect(data.errorMessage).toBeTruthy();
    expect(data.searchedUrl).toBe(TRADEME_URL);
    expect(data.listingUrls).toEqual(['https://example.com/item-a']);
  });

  it('surfaces an error and does not re-search when the cache-clear request throws (network error)', async () => {
    const card = await setUpCachedCard(TRADEME_URL, 'https://example.com/item-a');
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push({ url });
        return Promise.reject(new Error('network down'));
      })
    );

    await clearQuickSearchCacheAsync(card);

    expect(calls).toHaveLength(1);
    const data = urlCardData(card);
    expect(data.errorMessage).toBeTruthy();
    expect(data.listingUrls).toEqual(['https://example.com/item-a']);
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

describe('searchUrlCardAsync — isNewFromSearch tagging', () => {
  it('tags a listing isNewFromSearch when its card URL has condition=new', async () => {
    const card = addSearchableCardWithUrl(
      'https://www.trademe.co.nz/a/marketplace/search?condition=new'
    );
    stubQuickSearchStream([
      'data: {"type":"listing","data":{"source":"trademe","title":"t","price":10,"location":"","url":"https://example.com/new-item","isAuction":false,"relevance":0}}\n',
    ]);

    await searchUrlCardAsync(card);

    const item = listingsByUrl.get('https://example.com/new-item');
    expect(item?.isNewFromSearch).toBe(true);
  });

  it('leaves isNewFromSearch false for a listing from a card URL without condition=new', async () => {
    const card = addSearchableCard();
    stubQuickSearchStream([
      'data: {"type":"listing","data":{"source":"trademe","title":"t","price":10,"location":"","url":"https://example.com/normal-item","isAuction":false,"relevance":0}}\n',
    ]);

    await searchUrlCardAsync(card);

    const item = listingsByUrl.get('https://example.com/normal-item');
    expect(item?.isNewFromSearch).toBe(false);
  });
});

describe('searchUrlCardAsync — isNewFromSearch merge across duplicate arrivals', () => {
  // Discovery fires a "used" card and a "new" card concurrently for the same
  // prompt (cardSearch.ts's fireAllCardSearches), and both can surface the
  // same underlying listing under different URLs. listingDedupeKey collapses
  // them to one stored item — regardless of which card's SSE event lands
  // first, the merged item must end up isNewFromSearch: true, since one of the two
  // matching searches confirmed it. A first-write-wins merge would make the
  // result depend on arrival order instead.
  const usedCardUrl = TRADEME_URL;
  const newCardUrl = 'https://www.trademe.co.nz/a/marketplace/search?condition=new';
  const usedListingLine =
    'data: {"type":"listing","data":{"source":"trademe","title":"Widget","price":20,"location":"Auckland","url":"https://example.com/widget?ref=used","isAuction":false,"relevance":0}}\n';
  const newListingLine =
    'data: {"type":"listing","data":{"source":"trademe","title":"Widget","price":20,"location":"Auckland","url":"https://example.com/widget?ref=new","isAuction":false,"relevance":0}}\n';

  it('ends up isNewFromSearch: true when the used-condition arrival is processed first', async () => {
    const usedCard = addSearchableCardWithUrl(usedCardUrl);
    const newCard = addSearchableCardWithUrl(newCardUrl);

    stubQuickSearchStream([usedListingLine]);
    await searchUrlCardAsync(usedCard);
    stubQuickSearchStream([newListingLine]);
    await searchUrlCardAsync(newCard);

    expect(listingUrlByDedupeKey.size).toBe(1);
    const storedUrl = listingUrlByDedupeKey.values().next().value as string;
    expect(listingsByUrl.get(storedUrl)?.isNewFromSearch).toBe(true);
  });

  it('ends up isNewFromSearch: true when the new-condition arrival is processed first', async () => {
    const usedCard = addSearchableCardWithUrl(usedCardUrl);
    const newCard = addSearchableCardWithUrl(newCardUrl);

    stubQuickSearchStream([newListingLine]);
    await searchUrlCardAsync(newCard);
    stubQuickSearchStream([usedListingLine]);
    await searchUrlCardAsync(usedCard);

    expect(listingUrlByDedupeKey.size).toBe(1);
    const storedUrl = listingUrlByDedupeKey.values().next().value as string;
    expect(listingsByUrl.get(storedUrl)?.isNewFromSearch).toBe(true);
  });
});
