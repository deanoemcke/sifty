// ── URL card rows ─────────────────────────────────────────────────────────────
// Lifecycle of the URL input rows: create/remove, status-line rendering,
// input-mode switching, per-card cancel, and full result reset. The search
// action itself is injected into createUrlCard so this module never depends
// on the quick-search implementation.

import { isValidRecipeUrl, recipeGroupIdForUrl } from '../lib/recipes/matcher';
import type { RecipeId } from '../lib/recipes/metadata';
import { getElement, requireChild } from './domUtils';
import { esc } from './html';
import { applyClientFilters, getCardByUrl, getOrderedListings, renderDerived } from './resultsView';
import { type CardStatusSnapshot, cardStatusText } from './searchStatusText';
import {
  canCancelSearch,
  cardIdByUrl,
  clearListings,
  isCardSearchActive,
  isDeepSearchRunning,
  isSearchButtonDisabled,
  removeListingByUrl,
  setAiFilterPendingRun,
  setIsAiFilterRunning,
  type UrlCardData,
} from './state';
import {
  addUrlCard,
  removeUrlCardEntry,
  type UrlCard,
  type UrlCardDom,
  urlCardData,
  urlCards,
} from './urlCardStore';
import { expandUrlGroup, syncUrlGroups, updateUrlGroupHeaders } from './urlGroupsView';

export function cardStatusSnapshot(card: UrlCard): CardStatusSnapshot {
  const data = urlCardData(card);
  return {
    searchStatus: data.searchStatus,
    lastProgress: data.lastProgress,
    listingsFoundCount: data.listingUrls.length,
    errorMessage: data.errorMessage,
    wasCancelled: data.wasCancelled,
  };
}

// Single renderer for the per-row status line — wording derives from the
// card's semantic state via searchStatusText, never from ad-hoc strings.
export function renderCardStatus(card: UrlCard): void {
  renderUrlRowMode(card);
  const status = cardStatusText(cardStatusSnapshot(card));
  const statusBar = card.dom.statusElement;
  if (!status) {
    statusBar.classList.add('hidden');
    return;
  }
  statusBar.className = `url-card-status ${status.kind}`;
  statusBar.innerHTML =
    status.kind === 'info'
      ? `<span class="spinner"></span><span>${esc(status.text)}</span>`
      : `<span>${esc(status.text)}</span>`;
  if (canCancelSearch(urlCardData(card).searchStatus)) {
    const cancelButton = document.createElement('button');
    cancelButton.className = 'cache-clear-btn';
    cancelButton.style.marginLeft = '0.5rem';
    cancelButton.textContent = 'cancel';
    cancelButton.addEventListener('click', () => cancelSearch(card));
    statusBar.appendChild(cancelButton);
  }
  statusBar.classList.remove('hidden');
  updateUrlGroupHeaders();
}

export function cancelSearch(card: UrlCard): void {
  const data = urlCardData(card);
  if (!canCancelSearch(data.searchStatus)) return;
  data.searchStatus = 'cancelling';
  renderCardStatus(card);
  fetch('/api/cancel-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchId: data.searchId }),
  }).catch(() => null);
}

export function cancelGroupSearches(groupId: RecipeId): void {
  for (const card of urlCards) {
    if (recipeGroupIdForUrl(card.dom.input.value.trim()) === groupId) cancelSearch(card);
  }
}

export function handleUrlInputChanged(card: UrlCard): void {
  const groupId = recipeGroupIdForUrl(card.dom.input.value.trim());
  const previousParent = card.dom.containerElement.parentElement;
  syncUrlGroups();
  // A row that just moved into a collapsed group would vanish mid-edit —
  // expand its destination group so the input stays visible.
  if (card.dom.containerElement.parentElement !== previousParent && groupId !== null)
    expandUrlGroup(groupId);
}

// Once a search has touched the row, the URL displays as a truncated link;
// the (hidden) input stays the single source of the row's URL value.
export function renderUrlRowMode(card: UrlCard): void {
  const data = urlCardData(card);
  const url = card.dom.input.value.trim();
  const showLink =
    !data.isEditing &&
    (data.searchStatus !== 'idle' || data.wasCancelled || data.searchedUrl !== '');
  card.dom.linkElement.href = url;
  card.dom.linkElement.textContent = url;
  card.dom.linkElement.classList.toggle('hidden', !showLink);
  card.dom.input.classList.toggle('hidden', showLink);
  card.dom.editButton.classList.toggle(
    'hidden',
    !showLink || isCardSearchActive(data.searchStatus)
  );
}

export function canSearchCard(card: UrlCard): boolean {
  const data = urlCardData(card);
  const current = card.dom.input.value.trim();
  return (
    !isDeepSearchRunning &&
    isValidRecipeUrl(current) &&
    !isSearchButtonDisabled(data.searchStatus, data.searchedUrl, current)
  );
}

export function isDuplicateUrl(card: UrlCard): boolean {
  const current = card.dom.input.value.trim();
  if (!current) return false;
  return urlCards.some((other) => other !== card && other.dom.input.value.trim() === current);
}

function attemptSearchCard(card: UrlCard, searchCardAsync: (card: UrlCard) => Promise<void>): void {
  if (isDuplicateUrl(card)) {
    const data = urlCardData(card);
    data.errorMessage = 'This URL has already been added.';
    renderCardStatus(card);
    return;
  }
  if (canSearchCard(card)) searchCardAsync(card);
}

// assets/x.svg, inlined so it inherits currentColor.
export const X_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5L19 19M5 19L19 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const EDIT_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="m15 5 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function createUrlCard(searchCardAsync: (card: UrlCard) => Promise<void>): UrlCard {
  const cardEl = document.createElement('div');
  cardEl.className = 'source-url-row';
  cardEl.innerHTML = `
    <div class="url-row">
      <a class="url-link hidden" target="_blank" rel="noopener noreferrer"></a>
      <textarea class="url-input" rows="3" placeholder="Paste search URL…"></textarea>
      <button class="btn icon-btn url-edit-btn hidden" type="button" title="Edit">${EDIT_ICON}</button>
      <button class="btn icon-btn url-remove-btn hidden" type="button" title="Remove">${X_ICON}</button>
    </div>
    <div class="url-card-status hidden"></div>
    <div class="url-criteria hidden"><div class="criteria-grid"></div><div class="cache-status hidden"></div></div>
  `;
  getElement('urlCardsContainer').appendChild(cardEl);

  const input = requireChild<HTMLTextAreaElement>(cardEl, '.url-input');
  const linkElement = requireChild<HTMLAnchorElement>(cardEl, '.url-link');
  const editButton = requireChild<HTMLButtonElement>(cardEl, '.url-edit-btn');
  const removeButton = requireChild<HTMLButtonElement>(cardEl, '.url-remove-btn');
  const criteriaElement = requireChild<HTMLElement>(cardEl, '.url-criteria');
  const cacheStatusElement = requireChild<HTMLElement>(cardEl, '.cache-status');
  const statusElement = requireChild<HTMLElement>(cardEl, '.url-card-status');

  const data: UrlCardData = {
    searchStatus: 'idle',
    searchedUrl: '',
    searchId: null,
    listingUrls: [],
    lastProgress: null,
    errorMessage: null,
    wasCancelled: false,
    isEditing: false,
  };
  const dom: UrlCardDom = {
    containerElement: cardEl,
    input,
    linkElement,
    editButton,
    removeButton,
    criteriaElement,
    cacheStatusElement,
    statusElement,
  };
  const urlCard = addUrlCard(dom, data);

  input.addEventListener('input', () => {
    const cardData = urlCardData(urlCard);
    if (cardData.searchStatus === 'idle' && cardData.errorMessage !== null) {
      cardData.errorMessage = null;
      renderCardStatus(urlCard);
    }
    handleUrlInputChanged(urlCard);
  });
  input.addEventListener('keydown', (keyboardEvent: KeyboardEvent) => {
    if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      attemptSearchCard(urlCard, searchCardAsync);
    }
  });
  input.addEventListener('blur', () => attemptSearchCard(urlCard, searchCardAsync));
  editButton.addEventListener('click', () => {
    const data = urlCardData(urlCard);
    data.isEditing = true;
    input.readOnly = false;
    renderUrlRowMode(urlCard);
    input.focus();
  });
  removeButton.addEventListener('click', () => removeUrlCard(urlCard));

  updateRemoveButtons();
  syncUrlGroups();
  return urlCard;
}

export function resetAllResults(): void {
  setIsAiFilterRunning(false);
  setAiFilterPendingRun(false);
  clearListings();
  getElement('listingsContainer').innerHTML = '';
  getElement('resultsSection').classList.add('hidden');
  for (const card of urlCards) {
    const data = urlCardData(card);
    data.listingUrls = [];
    data.searchStatus = 'idle';
    data.searchedUrl = '';
    data.lastProgress = null;
    data.errorMessage = null;
    data.wasCancelled = false;
    requireChild<HTMLElement>(card.dom.criteriaElement, '.criteria-grid').innerHTML = '';
    card.dom.criteriaElement.classList.add('hidden');
    card.dom.cacheStatusElement.classList.add('hidden');
    card.dom.cacheStatusElement.innerHTML = '';
    card.dom.statusElement.classList.add('hidden');
    data.searchId = null;
    card.dom.input.readOnly = false;
    renderUrlRowMode(card);
  }
  renderDerived();
}

export function updateRemoveButtons(): void {
  const show = urlCards.length > 1;
  for (const card of urlCards) card.dom.removeButton.classList.toggle('hidden', !show);
}

export function resetCardForResearch(card: UrlCard): void {
  const data = urlCardData(card);
  const otherUrls = new Set(
    urlCards.flatMap((c) => (c === card ? [] : urlCardData(c).listingUrls))
  );
  for (const url of data.listingUrls) {
    if (!otherUrls.has(url)) {
      getCardByUrl(url)?.remove();
      removeListingByUrl(url);
      cardIdByUrl.delete(url);
    }
  }
  data.listingUrls = [];
  data.searchStatus = 'idle';
  data.searchedUrl = '';
  data.lastProgress = null;
  data.errorMessage = null;
  data.wasCancelled = false;
  requireChild<HTMLElement>(card.dom.criteriaElement, '.criteria-grid').innerHTML = '';
  card.dom.criteriaElement.classList.add('hidden');
  card.dom.cacheStatusElement.classList.add('hidden');
  card.dom.cacheStatusElement.innerHTML = '';
  card.dom.statusElement.classList.add('hidden');
  card.dom.input.readOnly = false;
  renderUrlRowMode(card);
  if (getOrderedListings().length === 0) getElement('resultsSection').classList.add('hidden');
  renderDerived();
}

export function removeUrlCard(card: UrlCard): void {
  const otherUrls = new Set(
    urlCards.flatMap((c) => (c === card ? [] : urlCardData(c).listingUrls))
  );
  for (const url of urlCardData(card).listingUrls) {
    if (!otherUrls.has(url)) {
      getCardByUrl(url)?.remove();
      removeListingByUrl(url);
      cardIdByUrl.delete(url);
    }
  }
  card.dom.containerElement.remove();
  removeUrlCardEntry(card);
  if (getOrderedListings().length === 0) getElement('resultsSection').classList.add('hidden');
  updateRemoveButtons();
  syncUrlGroups();
  applyClientFilters();
}
