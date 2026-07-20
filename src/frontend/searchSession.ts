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
import { clearDraftSession, type DraftSession, scheduleDraftSessionSave } from './draftSession';
import { esc } from './html';
import { parseMaxPrice } from './parseUtils';
import { searchUrlCardAsync } from './quickSearch';
import { activateSidebarTab } from './sidebarTabs';
import {
  currentSearchId,
  currentSearchName,
  type DiscoverInputs,
  type SavedSearch,
  setActiveSidebarTab,
  setCurrentSearchId,
  setCurrentSearchName,
} from './state';
import {
  createUrlCard,
  handleUrlInputChanged,
  removeUrlCard,
  resetAllResults,
  X_ICON,
} from './urlCardRow';
import { readCardUrl, urlCards } from './urlCardStore';

export function markDirty(): void {
  getElement<HTMLButtonElement>('saveCurrentBtn').disabled = false;
  scheduleDraftSessionSave();
}

export function setSearchName(id: string | null, name: string | null): void {
  setCurrentSearchId(id);
  setCurrentSearchName(name);
  getElement<HTMLButtonElement>('saveCurrentBtn').disabled = true;
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
        <input type="checkbox" class="alert-on-new-listings-checkbox" title="Alert on new listings" aria-label="Alert on new listings" ${savedSearch.shouldAlertOnNewListings ? 'checked' : ''} />
      </label>
      <button class="btn icon-btn delete-saved-btn saved-search-col-delete" type="button" title="Delete">${X_ICON}</button>
    </div>
  `
    )
    .join('');
}

interface SaveSearchPayload {
  name: string;
  urls: string[];
  discoverInputs: DiscoverInputs;
  aiFilter: string | null;
}

function buildSaveSearchPayload(name: string): SaveSearchPayload | null {
  const urls = urlCards.map(readCardUrl).filter(Boolean);
  if (!name.trim() || urls.length === 0) return null;
  return {
    name: name.trim(),
    urls,
    discoverInputs: readDiscoverInputs(),
    aiFilter: getElement<HTMLTextAreaElement>('aiFilter').value.trim() || null,
  };
}

type CreateSavedSearchResult =
  | { status: 'ok'; id: string }
  | { status: 'conflict'; existingId: string }
  | { status: 'error' };

async function createSavedSearchAsync(
  payload: SaveSearchPayload
): Promise<CreateSavedSearchResult> {
  const response = await fetch('/api/saved-searches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, shouldAlertOnNewListings: false }),
  });
  if (response.status === 409) {
    const data = (await response.json()) as { existingId: string };
    return { status: 'conflict', existingId: data.existingId };
  }
  if (!response.ok) return { status: 'error' };
  const data = (await response.json()) as { id: string };
  return { status: 'ok', id: data.id };
}

async function updateSavedSearchAsync(
  id: string,
  payload: SaveSearchPayload
): Promise<'ok' | 'error'> {
  const response = await fetch(`/api/saved-searches/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);
  return response?.ok ? 'ok' : 'error';
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
  setSearchName(null, data.name);
  markDirty();
  getElement<HTMLTextAreaElement>('aiFilter').value = aiPrompt;
  // loadDiscoveryResults owns the dispatch: kick off a search for every configured card.
  void fireAllCardSearches(urlCards, searchUrlCardAsync);
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
  setSearchName(search.id, search.name);
  setActiveSidebarTab('search');
  activateSidebarTab(document, 'search');
  // A loaded favourite is already durable server-side (reachable via
  // ?search=<id>), so any local draft of what preceded it is now moot.
  clearDraftSession();
  // loadSavedSearchAsync owns the dispatch: kick off a search for every
  // configured card, and callers (e.g. urlState.ts resolving a deep-linked
  // modal) rely on this resolving only once results have actually arrived.
  await fireAllCardSearches(urlCards, searchUrlCardAsync);
}

// Restores an autosaved ad-hoc session (see draftSession.ts) on boot, when no
// ?search=<id> is present in the URL — mirrors loadSavedSearchAsync's shape
// minus the id/name/tab-activation, since a draft is never itself durable.
export async function restoreDraftSessionAsync(draft: DraftSession): Promise<void> {
  setUrlsSectionState('ready');
  trimUrlCardsToOne();
  applyLoadedDiscoverInputs(discoveryFormElements(), draft.discoverInputs);
  getElement<HTMLTextAreaElement>('aiFilter').value = draft.aiFilter;
  if (draft.urls.length === 0) return;
  urlCards[0].dom.input.value = draft.urls[0];
  for (let urlIndex = 1; urlIndex < draft.urls.length; urlIndex++) {
    createUrlCard(searchUrlCardAsync).dom.input.value = draft.urls[urlIndex];
  }
  for (const card of urlCards) handleUrlInputChanged(card);
  await fireAllCardSearches(urlCards, searchUrlCardAsync);
}

// Collapses back to a single blank session — used when URL/popstate handling
// finds no saved-search id but one was previously loaded (e.g. the user
// pressed Back past the point where they loaded a favourite). Any ad-hoc
// content that existed before that favourite was loaded is not recoverable.
export function unloadCurrentSearch(): void {
  trimUrlCardsToOne();
  urlCards[0].dom.input.value = '';
  handleUrlInputChanged(urlCards[0]);
  applyLoadedDiscoverInputs(discoveryFormElements(), { prompt: '', fulfillment: 'pickup' });
  getElement<HTMLTextAreaElement>('aiFilter').value = '';
  setSearchName(null, null);
  setUrlsSectionState('idle');
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
  const discoveryWarningsElement = getElement<HTMLDivElement>('discoveryWarnings');
  discoveryErrorElement.style.display = 'none';
  discoveryWarningsElement.style.display = 'none';
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
      warnings?: string[];
    };
    // A saved search was loaded while this request was in flight — its
    // result is stale and must not overwrite what the user is now looking at.
    if (requestId !== discoveryRequestId) return;
    if (!response.ok || !data.urls?.length) {
      discoveryErrorElement.textContent = data.error ?? 'Discovery failed';
      discoveryErrorElement.style.display = 'block';
      return;
    }
    if (data.warnings?.length) {
      discoveryWarningsElement.textContent = data.warnings.join(' · ');
      discoveryWarningsElement.style.display = 'block';
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
  hideSaveSearchError();
  getElement('saveSearchModal').classList.remove('hidden');
  input.focus();
}

export function closeSaveSearchModal(): void {
  getElement('saveSearchModal').classList.add('hidden');
}

function hideSaveSearchError(): void {
  const errorElement = getElement<HTMLDivElement>('saveSearchError');
  errorElement.style.display = 'none';
  errorElement.textContent = '';
}

function showSaveSearchError(message: string): void {
  const errorElement = getElement<HTMLDivElement>('saveSearchError');
  errorElement.textContent = message;
  errorElement.style.display = 'block';
}

async function finishSaveSearchAsync(id: string, name: string): Promise<void> {
  await fetchSavedSearchesAsync();
  setSearchName(id, name);
  closeSaveSearchModal();
  setActiveSidebarTab('favourites');
  activateSidebarTab(document, 'favourites');
  // The session is now durable server-side (reachable via ?search=<id>), so
  // the local draft that shadowed it while unsaved is no longer needed.
  clearDraftSession();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export async function handleSaveSearchConfirmAsync(): Promise<boolean> {
  const name = getElement<HTMLInputElement>('saveSearchName').value.trim();
  if (!name) return false;
  const payload = buildSaveSearchPayload(name);
  if (!payload) return false;

  const confirmButton = getElement<HTMLButtonElement>('saveSearchConfirmBtn');
  const saveFailedMessage = 'Could not save this favourite — try again.';
  hideSaveSearchError();
  confirmButton.disabled = true;
  try {
    if (name === currentSearchName && currentSearchId) {
      const status = await updateSavedSearchAsync(currentSearchId, payload);
      if (status === 'error') {
        showSaveSearchError(saveFailedMessage);
        return false;
      }
      await finishSaveSearchAsync(currentSearchId, name);
      return true;
    }

    const result = await createSavedSearchAsync(payload);
    if (result.status === 'conflict') {
      if (!window.confirm(`A saved search named "${name}" already exists. Overwrite it?`))
        return false;
      const status = await updateSavedSearchAsync(result.existingId, payload);
      if (status === 'error') {
        showSaveSearchError(saveFailedMessage);
        return false;
      }
      await finishSaveSearchAsync(result.existingId, name);
      return true;
    }
    if (result.status === 'ok') {
      await finishSaveSearchAsync(result.id, name);
      return true;
    }
    showSaveSearchError(saveFailedMessage);
    return false;
  } finally {
    confirmButton.disabled = false;
  }
}

// ── Saved-search list delegation ──────────────────────────────────────────────

export async function handleSavedSearchListClickAsync(
  mouseEvent: MouseEvent
): Promise<'loaded' | 'deleted' | 'none'> {
  const row = (mouseEvent.target as HTMLElement).closest<HTMLElement>('.saved-search-row');
  if (!row) return 'none';
  const savedSearchId = row.dataset.id;
  if (!savedSearchId) throw new Error('saved-search-row missing data-id attribute');
  if ((mouseEvent.target as HTMLElement).closest('.delete-saved-btn')) {
    await deleteSavedSearchAsync(savedSearchId);
    return 'deleted';
  }
  if ((mouseEvent.target as HTMLElement).closest('.load-saved-btn')) {
    mouseEvent.preventDefault();
    const response = await fetch(`/api/saved-searches/${savedSearchId}`);
    if (!response.ok) return 'none';
    const { search } = (await response.json()) as { search: SavedSearch };
    await loadSavedSearchAsync(search);
    return 'loaded';
  }
  return 'none';
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
