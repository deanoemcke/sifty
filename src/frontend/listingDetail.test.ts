// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getElement } from './domUtils';
import { deepSearchListingAsync, runDeepSearchAsync } from './listingDetail';
import { populateShowControls } from './showDropdown';
import {
  type ListingItem,
  listingsByUrl,
  resetState,
  setOpenModalListingUrl,
  urlCardDataById,
} from './state';
import { makeListing, makeListingItem, SHOW_DROPDOWN_FIXTURE_HTML } from './testFixtures';

function makeItem(url: string): ListingItem {
  return makeListingItem({
    data: makeListing({ url, title: `Listing ${url}`, location: 'Auckland' }),
  });
}

// Stubs the fetch call `streamPostAsync` makes, resolving every SSE event on
// one tick — matching the newline-delimited `data: {...}` framing streamPostAsync parses.
function stubDeepSearchStream(events: Record<string, unknown>[]): void {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  let index = 0;
  const reader = {
    read: async () => {
      if (index >= chunks.length) return { value: undefined, done: true };
      const value = encoder.encode(chunks[index]);
      index += 1;
      return { value, done: false };
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

beforeEach(() => {
  resetState();
  document.body.innerHTML = `
    <div id="listingModal" class="hidden"></div>
    <div id="listingModalBody"></div>
    <div id="statusBar" class="hidden"></div>
    <span id="resultCount"></span>
    <span id="totalCount"></span>
    <button id="deepBtn"></button>
    <textarea id="aiFilter"></textarea>
    <button id="aiFilterBtn"></button>
    <div id="urlCardsContainer"></div>
    ${SHOW_DROPDOWN_FIXTURE_HTML}
  `;
  populateShowControls();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deepSearchListingAsync', () => {
  it('does not mark the listing deep-searched when the fetch fails, and shows the error', async () => {
    const item = makeItem('https://www.trademe.co.nz/listing/1');
    setOpenModalListingUrl(item.data.url);
    stubDeepSearchStream([
      { type: 'detail-error', url: item.data.url, message: 'failed to fetch listing detail' },
    ]);

    await deepSearchListingAsync(item);

    expect(item.hasBeenDeepSearched).toBe(false);
    expect(getElement('listingModalBody').innerHTML).toContain('failed to fetch listing detail');
  });

  it('marks the listing deep-searched and merges data on a successful detail event', async () => {
    const item = makeItem('https://www.trademe.co.nz/listing/2');
    setOpenModalListingUrl(item.data.url);
    stubDeepSearchStream([
      { type: 'detail', url: item.data.url, detail: { description: 'Great item' } },
    ]);

    await deepSearchListingAsync(item);

    expect(item.hasBeenDeepSearched).toBe(true);
    expect(item.data.description).toBe('Great item');
  });
});

describe('runDeepSearchAsync — mixed success/failure batch', () => {
  it('leaves the failed listing eligible for retry while the successful one is marked done', async () => {
    const okItem = makeItem('https://www.trademe.co.nz/listing/ok');
    const failedItem = makeItem('https://www.trademe.co.nz/listing/failed');
    listingsByUrl.set(okItem.data.url, okItem);
    listingsByUrl.set(failedItem.data.url, failedItem);
    urlCardDataById.set('card-1', {
      searchStatus: 'done',
      searchedUrl: 'https://www.trademe.co.nz/search/test',
      searchId: null,
      listingUrls: [okItem.data.url, failedItem.data.url],
      lastProgress: null,
      errorMessage: null,
      wasCancelled: false,
    });

    stubDeepSearchStream([
      { type: 'detail', url: okItem.data.url, detail: { description: 'Great item' } },
      {
        type: 'detail-error',
        url: failedItem.data.url,
        message: 'failed to fetch listing detail',
      },
      { type: 'complete' },
    ]);

    await runDeepSearchAsync();

    expect(okItem.hasBeenDeepSearched).toBe(true);
    expect(failedItem.hasBeenDeepSearched).toBe(false);
  });
});
