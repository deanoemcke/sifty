// ── Search session ────────────────────────────────────────────────────────────
// Saved-search CRUD, the discovery submit flow, and loading either kind of
// result into the URL cards. Everything that turns a stored/discovered search
// into a live session lives here.

import { fireAllCardSearches } from './cardSearch';
import {
  applyLoadedDiscoverInputs,
  DISCOVERY_BUTTON_BUSY_LABEL,
  DISCOVERY_BUTTON_LABEL,
  discoveryFormElements,
  fulfillmentFromAllowShipping,
  readDiscoverInputs,
  updateDiscoveryBtn,
} from './discoveryForm';
import { getElement } from './domUtils';
import { esc } from './html';
import { parseMaxPrice } from './parseUtils';
import { searchUrlCardAsync } from './quickSearch';
import { activateSidebarTab } from './sidebarTabs';
import { currentSearchName, type SavedSearch, setCurrentSearchName } from './state';
import {
  createUrlCard,
  handleUrlInputChanged,
  removeUrlCard,
  resetAllResults,
  X_ICON,
} from './urlCardRow';
import { urlCards } from './urlCardStore';

export function markDirty(): void {
  getElement('saveCurrentBtn').classList.remove('hidden');
}

export function setSearchName(name: string | null): void {
  setCurrentSearchName(name);
  getElement('saveCurrentBtn').classList.add('hidden');
}

// ── Saved searches ────────────────────────────────────────────────────────────

export async function fetchSavedSearchesAsync(): Promise<void> {
  try {
    const response = await fetch('/api/saved-searches', { cache: 'no-store' });
    const data = (await response.json()) as { searches: SavedSearch[] };
    renderSavedSearches(data.searches);
  } catch {
    /* non-critical */
  }
}

export function renderSavedSearches(searches: SavedSearch[]): void {
  const list = getElement('savedSearchesList');
  const count = getElement('savedSearchesCount');
  const header = getElement('savedSearchesHeaderRow');

  count.textContent = String(searches.length);
  count.classList.toggle('hidden', searches.length === 0);
  header.classList.toggle('hidden', searches.length === 0);

  if (searches.length === 0) {
    list.innerHTML = '<p class="deep-empty">No favourites yet.</p>';
    return;
  }
  list.innerHTML = searches
    .map(
      (savedSearch) => `
    <div class="saved-search-row" data-id="${esc(savedSearch.id)}">
      <a class="saved-search-name load-saved-btn" href="#" title="${esc(savedSearch.name)}">${esc(savedSearch.name)}</a>
      <label class="saved-search-alert-cell">
        <input type="checkbox" class="alert-on-new-listings-checkbox" ${savedSearch.shouldAlertOnNewListings ? 'checked' : ''} />
      </label>
      <button class="btn icon-btn delete-saved-btn saved-search-col-delete" type="button" title="Delete">${X_ICON}</button>
    </div>
  `
    )
    .join('');
}

export async function saveCurrentSearchAsync(name: string): Promise<void> {
  const urls = urlCards.map((card) => card.dom.input.value.trim()).filter(Boolean);
  if (!name.trim() || urls.length === 0) return;
  const response = await fetch('/api/saved-searches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name.trim(),
      urls,
      discoverInputs: readDiscoverInputs(),
      aiFilter: getElement<HTMLTextAreaElement>('aiFilter').value.trim() || null,
      shouldAlertOnNewListings: false,
    }),
  });
  if (response.ok) await fetchSavedSearchesAsync();
}

export async function deleteSavedSearchAsync(id: string): Promise<void> {
  await fetch(`/api/saved-searches/${id}`, { method: 'DELETE' });
  await fetchSavedSearchesAsync();
}

type UrlsSectionState = 'idle' | 'discovering' | 'ready';

// The URL cards section stays hidden ("idle") until the first search of the
// session — either a discovery run or loading a favourite. Every caller that
// changes what the section shows goes through this so visibility ownership
// isn't implicit in call order.
export function setUrlsSectionState(state: UrlsSectionState): void {
  getElement('urlsSection').classList.toggle('hidden', state === 'idle');
  getElement('urlPlaceholder').classList.toggle('hidden', state !== 'discovering');
  getElement('urlCardsContainer').classList.toggle('hidden', state === 'discovering');
  getElement('addUrlBtn').classList.toggle('hidden', state === 'discovering');
}

// loadDiscoveryResults, loadSavedSearchAsync, and handleDiscoverySubmitAsync
// all start a new session by dropping down to a single, blank URL card.
function trimUrlCardsToOne(): void {
  resetAllResults();
  while (urlCards.length > 1) removeUrlCard(urlCards[urlCards.length - 1]);
}

export function loadDiscoveryResults(
  data: { urls: string[]; name: string },
  aiPrompt: string
): void {
  trimUrlCardsToOne();
  urlCards[0].dom.input.value = data.urls[0];
  for (let urlIndex = 1; urlIndex < data.urls.length; urlIndex++) {
    createUrlCard(searchUrlCardAsync).dom.input.value = data.urls[urlIndex];
  }
  for (const card of urlCards) handleUrlInputChanged(card);
  setSearchName(data.name);
  markDirty();
  getElement<HTMLTextAreaElement>('aiFilter').value = aiPrompt;
  // loadDiscoveryResults owns the dispatch: kick off a search for every configured card.
  fireAllCardSearches(urlCards, searchUrlCardAsync);
}

// Invalidates any in-flight handleDiscoverySubmitAsync request so its
// eventual response can't overwrite URL cards loaded by a newer request.
let discoveryRequestId = 0;

export async function loadSavedSearchAsync(search: SavedSearch): Promise<void> {
  discoveryRequestId++;
  setUrlsSectionState('ready');
  trimUrlCardsToOne();
  applyLoadedDiscoverInputs(discoveryFormElements(), search.discoverInputs);
  if (search.urls.length === 0) return;
  urlCards[0].dom.input.value = search.urls[0];
  for (let urlIndex = 1; urlIndex < search.urls.length; urlIndex++) {
    createUrlCard(searchUrlCardAsync).dom.input.value = search.urls[urlIndex];
  }
  for (const card of urlCards) handleUrlInputChanged(card);
  getElement<HTMLTextAreaElement>('aiFilter').value = search.aiFilter ?? '';
  setSearchName(search.name);
  activateSidebarTab(document, 'search');
  // loadSavedSearchAsync owns the dispatch: kick off a search for every configured card.
  fireAllCardSearches(urlCards, searchUrlCardAsync);
}

// ── Discovery submit ──────────────────────────────────────────────────────────

export async function handleDiscoverySubmitAsync(): Promise<void> {
  const requestId = ++discoveryRequestId;
  const prompt = getElement<HTMLTextAreaElement>('discoveryPrompt').value.trim();
  if (!prompt) return;
  const maxPrice = parseMaxPrice(getElement<HTMLInputElement>('discoveryMaxPrice').value);
  const fulfillment = fulfillmentFromAllowShipping(
    getElement<HTMLInputElement>('discoveryAllowShipping').checked
  );
  const includeSoldItems = getElement<HTMLInputElement>('discoveryIncludeSoldItems').checked;
  const includeNewItems = getElement<HTMLInputElement>('discoveryIncludeNewItems').checked;
  const regionValue = getElement<HTMLSelectElement>('discoveryRegion').value || undefined;
  const discoveryButton = getElement<HTMLButtonElement>('discoveryBtn');
  const discoveryErrorElement = getElement<HTMLDivElement>('discoveryError');
  discoveryErrorElement.style.display = 'none';
  discoveryButton.disabled = true;
  discoveryButton.textContent = DISCOVERY_BUTTON_BUSY_LABEL;
  setUrlsSectionState('discovering');
  trimUrlCardsToOne();
  urlCards[0].dom.input.value = '';
  handleUrlInputChanged(urlCards[0]);
  try {
    const response = await fetch('/api/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        maxPrice,
        fulfillment,
        includeSoldItems,
        includeNewItems,
        regionValue,
      }),
    });
    const data = (await response.json()) as {
      urls?: string[];
      name?: string;
      error?: string;
    };
    // A saved search was loaded while this request was in flight — its
    // result is stale and must not overwrite what the user is now looking at.
    if (requestId !== discoveryRequestId) return;
    if (!response.ok || !data.urls?.length) {
      discoveryErrorElement.textContent = data.error ?? 'Discovery failed';
      discoveryErrorElement.style.display = 'block';
      return;
    }
    loadDiscoveryResults(data as { urls: string[]; name: string }, prompt);
  } catch {
    if (requestId === discoveryRequestId) {
      discoveryErrorElement.textContent = 'Discovery failed';
      discoveryErrorElement.style.display = 'block';
    }
  } finally {
    discoveryButton.textContent = DISCOVERY_BUTTON_LABEL;
    updateDiscoveryBtn();
    setUrlsSectionState('ready');
  }
}

// ── Save-search modal ─────────────────────────────────────────────────────────

export function openSaveSearchModal(): void {
  const input = getElement<HTMLInputElement>('saveSearchName');
  input.value = currentSearchName ?? '';
  input.select();
  getElement('saveSearchModal').classList.remove('hidden');
  input.focus();
}

export function closeSaveSearchModal(): void {
  getElement('saveSearchModal').classList.add('hidden');
}

export async function handleSaveSearchConfirmAsync(): Promise<void> {
  const name = getElement<HTMLInputElement>('saveSearchName').value.trim();
  if (!name) return;
  const confirmButton = getElement<HTMLButtonElement>('saveSearchConfirmBtn');
  confirmButton.disabled = true;
  await saveCurrentSearchAsync(name);
  setSearchName(name);
  closeSaveSearchModal();
  confirmButton.disabled = false;
  activateSidebarTab(document, 'favourites');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Saved-search list delegation ──────────────────────────────────────────────

export async function handleSavedSearchListClickAsync(mouseEvent: MouseEvent): Promise<void> {
  const row = (mouseEvent.target as HTMLElement).closest<HTMLElement>('.saved-search-row');
  if (!row) return;
  const savedSearchId = row.dataset.id;
  if (!savedSearchId) throw new Error('saved-search-row missing data-id attribute');
  if ((mouseEvent.target as HTMLElement).closest('.delete-saved-btn')) {
    await deleteSavedSearchAsync(savedSearchId);
    return;
  }
  if ((mouseEvent.target as HTMLElement).closest('.load-saved-btn')) {
    mouseEvent.preventDefault();
    const response = await fetch(`/api/saved-searches/${savedSearchId}`);
    if (!response.ok) return;
    const { search } = (await response.json()) as { search: SavedSearch };
    await loadSavedSearchAsync(search);
  }
}

export async function handleSavedSearchAlertToggleAsync(changeEvent: Event): Promise<void> {
  const checkbox = (changeEvent.target as HTMLElement).closest<HTMLInputElement>(
    '.alert-on-new-listings-checkbox'
  );
  if (!checkbox) return;
  const row = checkbox.closest<HTMLElement>('.saved-search-row');
  const savedSearchId = row?.dataset.id;
  if (!savedSearchId) throw new Error('saved-search-row missing data-id attribute');

  const desiredValue = checkbox.checked;
  checkbox.disabled = true;
  try {
    const response = await fetch(`/api/saved-searches/${savedSearchId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shouldAlertOnNewListings: desiredValue }),
    });
    if (!response.ok) checkbox.checked = !desiredValue;
  } catch {
    checkbox.checked = !desiredValue;
  } finally {
    checkbox.disabled = false;
  }
}
