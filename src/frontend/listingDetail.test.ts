// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getElement } from './domUtils';
import {
  closeListingModal,
  deepSearchListingAsync,
  listingModalExtrasHtml,
  openListingModalAsync,
  renderListingModalContent,
  runDeepSearchAsync,
} from './listingDetail';
import { populateShowControls } from './showDropdown';
import {
  type ListingItem,
  listingsByUrl,
  resetState,
  setOpenModalListingUrl,
  urlCardDataById,
} from './state';
import { makeListing, makeListingItem } from './testFixtures';

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
  document.body.className = '';
  history.replaceState(null, '');
  document.body.innerHTML = `
    <div id="listingModal" class="hidden"></div>
    <div id="listingModalBody"></div>
    <div id="statusBar" class="hidden"></div>
    <button id="deepBtn"></button>
    <textarea id="aiFilter"></textarea>
    <button id="aiFilterBtn"></button>
    <div id="urlCardsContainer"></div>
    <div id="showDropdown"></div>
  `;
  populateShowControls();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      isEditing: false,
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

describe('renderListingModalContent header', () => {
  it('does not render a thumbnail', () => {
    const item = makeItem('https://example.com/no-thumb');
    setOpenModalListingUrl(item.data.url);

    renderListingModalContent(item);

    expect(getElement('listingModalBody').innerHTML).not.toContain('listing-modal-thumb');
  });

  it("shows the listing's url as the link text, directly below the title", () => {
    const item = makeItem('https://example.com/link-text-test');
    setOpenModalListingUrl(item.data.url);

    renderListingModalContent(item);

    const html = getElement('listingModalBody').innerHTML;
    expect(html).toContain(`>${item.data.url}<`);
    const titleIndex = html.indexOf('listing-modal-title');
    const linkIndex = html.indexOf('listing-modal-original-link');
    const metaIndex = html.indexOf('listing-meta');
    expect(titleIndex).toBeLessThan(linkIndex);
    expect(linkIndex).toBeLessThan(metaIndex);
  });
});

describe('listingModalExtrasHtml', () => {
  it('shows the quick-scrape thumbnail under Photos while deep search is still pending', () => {
    const item = makeListingItem({
      hasBeenDeepSearched: false,
      data: makeListing({ thumbnailUrl: 'https://example.com/quick-thumb.jpg' }),
    });

    const html = listingModalExtrasHtml(item, null);

    expect(html).toContain('photo-gallery');
    expect(html).toContain('src="https://example.com/quick-thumb.jpg"');
    expect(html).toContain('Fetching details…');
  });

  it('omits the Photos section while pending when no quick-scrape thumbnail is known', () => {
    const item = makeListingItem({ hasBeenDeepSearched: false, data: makeListing() });

    const html = listingModalExtrasHtml(item, null);

    expect(html).not.toContain('photo-gallery');
    expect(html).toContain('Fetching details…');
  });

  it('renders the deep-search photos once deep search has completed', () => {
    const item = makeListingItem({
      hasBeenDeepSearched: true,
      data: makeListing({
        thumbnailUrl: 'https://example.com/quick-thumb.jpg',
        photos: [
          {
            thumbnailUrl: 'https://example.com/full-thumb.jpg',
            fullSizeUrl: 'https://example.com/full.jpg',
          },
        ],
      }),
    });

    const html = listingModalExtrasHtml(item, null);

    expect(html).toContain('src="https://example.com/full-thumb.jpg"');
    expect(html).not.toContain('quick-thumb.jpg');
    expect(html).not.toContain('Fetching details…');
  });
});

describe('listing modal scroll lock', () => {
  function makeSearchedItem(url: string): ListingItem {
    return makeListingItem({
      hasBeenDeepSearched: true,
      data: makeListing({ url, title: `Listing ${url}`, location: 'Auckland' }),
    });
  }

  it('locks body scroll on open, without touching history itself', async () => {
    const pushSpy = vi.spyOn(history, 'pushState');
    await openListingModalAsync(makeSearchedItem('https://example.com/a'));
    expect(document.body.classList.contains('scroll-locked')).toBe(true);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('unlocks body scroll on close, without touching history itself', async () => {
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    await openListingModalAsync(makeSearchedItem('https://example.com/a'));
    closeListingModal();
    expect(document.body.classList.contains('scroll-locked')).toBe(false);
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('takes no arguments', async () => {
    await openListingModalAsync(makeSearchedItem('https://example.com/a'));
    expect(closeListingModal.length).toBe(0);
  });
});
