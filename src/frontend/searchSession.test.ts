// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleDiscoverySubmitAsync,
  handleSavedSearchAlertToggleAsync,
  handleSaveSearchConfirmAsync,
  loadSavedSearchAsync,
  renderSavedSearches,
} from './searchSession';
import { populateShowControls } from './showDropdown';
import { currentSearchId, currentSearchName, resetState, type SavedSearch } from './state';
import { createUrlCard } from './urlCardRow';
import { resetUrlCardStore, urlCards } from './urlCardStore';

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  document.body.innerHTML = `
    <textarea id="discoveryPrompt">lamp</textarea>
    <input id="discoveryMaxPrice" />
    <input id="discoveryAllowShipping" type="checkbox" />
    <input id="discoveryIncludeSoldItems" type="checkbox" />
    <input id="discoveryIncludeNewItems" type="checkbox" />
    <select id="discoveryRegion"><option value="">Any</option></select>
    <button id="discoveryBtn"></button>

    <div id="urlsSection" class="hidden">
      <div id="urlsCard" class="card">
        <div id="discoveryError" style="display:none"></div>
        <div id="urlPlaceholder" class="hidden">
          <span class="spinner"></span><span>Discovering urls…</span>
        </div>
        <div id="urlCardsContainer">
        </div>
        <button id="addUrlBtn" />
      </div>
    </div>

    <div id="resultsSection" class="hidden"></div>
    <div id="listingsContainer"></div>
    <div id="showDropdown"></div>
    <button id="deepBtn"></button>
    <textarea id="aiFilter"></textarea>
    <button id="aiFilterBtn"></button>

    <button id="searchTabBtn" class="active"></button>
    <button id="favouritesTabBtn"></button>
    <div id="searchTabPanel"></div>
    <div id="savedSearchesPanel" class="hidden">
      <div id="savedSearchesHeaderRow" class="hidden"></div>
      <div id="savedSearchesList"></div>
      <span id="savedSearchesCount" class="hidden">0</span>
    </div>
    <button id="saveCurrentBtn" class="hidden"></button>

    <div id="saveSearchModal" class="hidden">
      <input id="saveSearchName" />
      <button id="saveSearchCancelBtn"></button>
      <button id="saveSearchConfirmBtn"></button>
    </div>
  `;
  populateShowControls();
  // The app always seeds one blank URL card on init (see app.ts) — every
  // caller of handleDiscoverySubmitAsync relies on urlCards[0] existing.
  createUrlCard(async () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('shows a discovering placeholder immediately, before the discover request resolves. then hides discovering placeholder, after the discover request resolves', async () => {
  urlCards[0].dom.input.value = 'https://www.trademe.co.nz/stale';

  let resolveFetch!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    )
  );

  const submitPromise = handleDiscoverySubmitAsync();

  // Fetch hasn't resolved yet — assert on the mid-flight state.
  expect(document.getElementById('urlsCard')?.classList.contains('hidden')).toBe(false);
  expect(document.getElementById('urlCardsContainer')?.classList.contains('hidden')).toBe(true);
  expect(document.getElementById('addUrlBtn')?.classList.contains('hidden')).toBe(true);
  expect(document.getElementById('urlPlaceholder')?.classList.contains('hidden')).toBe(false);

  resolveFetch({
    ok: true,
    json: async () => ({ urls: ['https://www.trademe.co.nz/x'], name: 'lamp' }),
  });
  await submitPromise;

  // Assert on the post-flight state.
  expect(document.getElementById('urlsCard')?.classList.contains('hidden')).toBe(false);
  expect(document.getElementById('urlCardsContainer')?.classList.contains('hidden')).toBe(false);
  expect(document.getElementById('addUrlBtn')?.classList.contains('hidden')).toBe(false);
  expect(document.getElementById('urlPlaceholder')?.classList.contains('hidden')).toBe(true);
  expect(document.getElementById('urlsSection')?.classList.contains('hidden')).toBe(false);
  expect(urlCards[0].dom.input.value).toBe('https://www.trademe.co.nz/x');
});

it('shows the discovery error and leaves the URL input blank when the discover request fails', async () => {
  urlCards[0].dom.input.value = 'https://www.trademe.co.nz/stale';

  let resolveFetch!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    )
  );

  const submitPromise = handleDiscoverySubmitAsync();

  resolveFetch({
    ok: false,
    json: async () => ({ error: 'No listings found' }),
  });
  await submitPromise;

  expect(document.getElementById('discoveryError')?.textContent).toBe('No listings found');
  expect((document.getElementById('discoveryError') as HTMLDivElement).style.display).toBe('block');
  expect(urlCards[0].dom.input.value).toBe('');
  expect(document.getElementById('urlCardsContainer')?.classList.contains('hidden')).toBe(false);
  expect(document.getElementById('urlPlaceholder')?.classList.contains('hidden')).toBe(true);
});

it('clears any existing URL card value immediately when a new discovery is submitted, before the fetch resolves', async () => {
  urlCards[0].dom.input.value = 'https://www.trademe.co.nz/stale';

  let resolveFetch!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    )
  );

  const submitPromise = handleDiscoverySubmitAsync();

  expect(urlCards).toHaveLength(1);
  expect(urlCards[0].dom.input.value).toBe('');

  resolveFetch({
    ok: true,
    json: async () => ({ urls: ['https://www.trademe.co.nz/x'], name: 'lamp' }),
  });
  await submitPromise;
});

it('includes includeNewItems, read from the checkbox, in the /api/discover request body', async () => {
  (document.getElementById('discoveryIncludeNewItems') as HTMLInputElement).checked = true;

  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ urls: ['https://www.trademe.co.nz/x'], name: 'lamp' }),
  });
  vi.stubGlobal('fetch', fetchMock);

  await handleDiscoverySubmitAsync();

  const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(requestBody.includeNewItems).toBe(true);
});

it('does not let a stale discovery response overwrite a saved search loaded while it was in flight', async () => {
  let resolveFetch!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    )
  );

  const submitPromise = handleDiscoverySubmitAsync();

  // Discovery is still in flight — placeholder showing, container hidden.
  expect(document.getElementById('urlCardsContainer')?.classList.contains('hidden')).toBe(true);

  // User loads a saved search before the discovery request resolves.
  await loadSavedSearchAsync({
    id: 'saved-1',
    name: 'saved search',
    urls: ['https://example.com/saved'],
    aiFilter: null,
    createdAt: 0,
    shouldAlertOnNewListings: false,
  });

  // The saved search must be visible immediately, not stuck behind the placeholder.
  expect(document.getElementById('urlCardsContainer')?.classList.contains('hidden')).toBe(false);
  expect(urlCards[0].dom.input.value).toBe('https://example.com/saved');

  // The stale discovery now resolves successfully.
  resolveFetch({
    ok: true,
    json: async () => ({ urls: ['https://www.trademe.co.nz/stale'], name: 'lamp' }),
  });
  await submitPromise;

  // It must not clobber the saved search the user is now looking at.
  expect(urlCards[0].dom.input.value).toBe('https://example.com/saved');
});

it('loading a saved search with includeSoldItems restores the checkbox, but the "Show > Sold" row stays hidden until results actually contain a sold listing', async () => {
  // The Show > Sold row is gated on the current results' tally (see
  // showDropdown.ts renderShowOptions), not on this checkbox — it's a
  // search-time input restored here for the next search, and loading a saved
  // search with no urls produces no results to search, so there is nothing
  // sold to reveal the row pre-emptively for.
  expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(true);

  await loadSavedSearchAsync({
    id: 'saved-2',
    name: 'saved search with sold items',
    urls: [],
    aiFilter: null,
    createdAt: 0,
    shouldAlertOnNewListings: false,
    discoverInputs: {
      prompt: 'lamp',
      maxPrice: 50,
      fulfillment: 'any',
      includeSoldItems: true,
    },
  });

  expect((document.getElementById('discoveryIncludeSoldItems') as HTMLInputElement).checked).toBe(
    true
  );
  expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(true);
});

function makeSavedSearch(overrides: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: 'saved-1',
    name: 'saved search',
    urls: ['https://example.com/saved'],
    aiFilter: null,
    createdAt: 0,
    shouldAlertOnNewListings: false,
    ...overrides,
  };
}

describe('renderSavedSearches', () => {
  it('hides the header row when there are no saved searches', () => {
    renderSavedSearches([]);

    expect(document.getElementById('savedSearchesHeaderRow')?.classList.contains('hidden')).toBe(
      true
    );
  });

  it('shows the header row and a checkbox reflecting shouldAlertOnNewListings for each row', () => {
    renderSavedSearches([
      makeSavedSearch({ id: 'a', shouldAlertOnNewListings: true }),
      makeSavedSearch({ id: 'b', shouldAlertOnNewListings: false }),
    ]);

    expect(document.getElementById('savedSearchesHeaderRow')?.classList.contains('hidden')).toBe(
      false
    );
    const rows = document.querySelectorAll('.saved-search-row');
    expect(rows).toHaveLength(2);
    expect(
      (rows[0].querySelector('.alert-on-new-listings-checkbox') as HTMLInputElement).checked
    ).toBe(true);
    expect(
      (rows[1].querySelector('.alert-on-new-listings-checkbox') as HTMLInputElement).checked
    ).toBe(false);
  });

  it('gives the alert checkbox an accessible name', () => {
    renderSavedSearches([makeSavedSearch({ id: 'a' })]);

    const checkbox = document.querySelector('.alert-on-new-listings-checkbox') as HTMLInputElement;
    expect(checkbox.getAttribute('aria-label')).toBe('Alert on new listings');
    expect(checkbox.getAttribute('title')).toBe('Alert on new listings');
  });
});

describe('handleSavedSearchAlertToggleAsync', () => {
  it('PATCHes the toggled row id and checked state', async () => {
    renderSavedSearches([makeSavedSearch({ id: 'a', shouldAlertOnNewListings: false })]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const checkbox = document.querySelector('.alert-on-new-listings-checkbox') as HTMLInputElement;
    checkbox.checked = true;
    await handleSavedSearchAlertToggleAsync({ target: checkbox } as unknown as Event);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/saved-searches/a',
      expect.objectContaining({ method: 'PATCH' })
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toEqual({ shouldAlertOnNewListings: true });
  });

  it('reverts the checkbox when the PATCH request fails', async () => {
    renderSavedSearches([makeSavedSearch({ id: 'a', shouldAlertOnNewListings: false })]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const checkbox = document.querySelector('.alert-on-new-listings-checkbox') as HTMLInputElement;
    checkbox.checked = true;
    await handleSavedSearchAlertToggleAsync({ target: checkbox } as unknown as Event);

    expect(checkbox.checked).toBe(false);
  });

  it('disables the checkbox while the PATCH request is in flight and re-enables it once it resolves', async () => {
    renderSavedSearches([makeSavedSearch({ id: 'a', shouldAlertOnNewListings: false })]);
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      )
    );

    const checkbox = document.querySelector('.alert-on-new-listings-checkbox') as HTMLInputElement;
    checkbox.checked = true;
    const togglePromise = handleSavedSearchAlertToggleAsync({
      target: checkbox,
    } as unknown as Event);

    // Fetch hasn't resolved yet — assert on the mid-flight state.
    expect(checkbox.disabled).toBe(true);

    resolveFetch({ ok: true });
    await togglePromise;

    expect(checkbox.disabled).toBe(false);
  });

  it('reverts the checkbox and resolves cleanly (no unhandled rejection) when the fetch itself rejects', async () => {
    renderSavedSearches([makeSavedSearch({ id: 'a', shouldAlertOnNewListings: false })]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const checkbox = document.querySelector('.alert-on-new-listings-checkbox') as HTMLInputElement;
    checkbox.checked = true;

    await expect(
      handleSavedSearchAlertToggleAsync({ target: checkbox } as unknown as Event)
    ).resolves.toBeUndefined();

    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
  });
});

describe('handleSaveSearchConfirmAsync', () => {
  function setSaveSearchName(name: string): void {
    (document.getElementById('saveSearchName') as HTMLInputElement).value = name;
  }

  it('POSTs a new saved search when nothing is loaded and the name is unique', async () => {
    urlCards[0].dom.input.value = 'https://example.com/x';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'new-id' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ searches: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    setSaveSearchName('New search');

    await handleSaveSearchConfirmAsync();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/saved-searches',
      expect.objectContaining({ method: 'POST' })
    );
    expect(currentSearchId).toBe('new-id');
    expect(currentSearchName).toBe('New search');
    expect(document.getElementById('saveSearchModal')?.classList.contains('hidden')).toBe(true);
  });

  it("PUTs to the loaded favourite's id when re-saving under its own unchanged name", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await loadSavedSearchAsync(
      makeSavedSearch({ id: 'fav-1', name: 'My favourite', urls: ['https://example.com/saved'] })
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ searches: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    setSaveSearchName('My favourite');

    await handleSaveSearchConfirmAsync();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/saved-searches/fav-1',
      expect.objectContaining({ method: 'PUT' })
    );
    expect(currentSearchId).toBe('fav-1');
  });

  it('POSTs a new favourite (not a PUT) when renaming a loaded favourite to a new non-colliding name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await loadSavedSearchAsync(
      makeSavedSearch({ id: 'fav-1', name: 'Old name', urls: ['https://example.com/saved'] })
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'new-id' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ searches: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    setSaveSearchName('New name');

    await handleSaveSearchConfirmAsync();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/saved-searches',
      expect.objectContaining({ method: 'POST' })
    );
    expect(currentSearchId).toBe('new-id');
  });

  it('does not overwrite and keeps the modal open when the user declines the overwrite confirmation', async () => {
    urlCards[0].dom.input.value = 'https://example.com/x';
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ existingId: 'other-id' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    document.getElementById('saveSearchModal')?.classList.remove('hidden');
    setSaveSearchName('Existing name');

    await handleSaveSearchConfirmAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('saveSearchModal')?.classList.contains('hidden')).toBe(false);
  });

  it('overwrites the existing favourite by id when the user accepts the overwrite confirmation', async () => {
    urlCards[0].dom.input.value = 'https://example.com/x';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ existingId: 'other-id' }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ searches: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    setSaveSearchName('Existing name');

    await handleSaveSearchConfirmAsync();

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/saved-searches/other-id',
      expect.objectContaining({ method: 'PUT' })
    );
    expect(currentSearchId).toBe('other-id');
    expect(document.getElementById('saveSearchModal')?.classList.contains('hidden')).toBe(true);
  });
});
