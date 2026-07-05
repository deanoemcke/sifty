// ── URL card rows ─────────────────────────────────────────────────────────────
// Lifecycle of the URL input rows: create/remove, status-line rendering,
// input-mode switching, per-card cancel, and full result reset. The search
// action itself is injected into createUrlCard so this module never depends
// on the quick-search implementation.

import { isValidRecipeUrl, recipeIdForUrl } from "../lib/recipes/matcher";
import type { RecipeId } from "../lib/recipes/metadata";
import { getElement, requireChild } from "./domUtils";
import { esc } from "./html";
import {
  applyClientFilters,
  getCardByUrl,
  getOrderedListings,
  renderDerived,
  renderFilteredToggle,
} from "./resultsView";
import { type CardStatusSnapshot, cardStatusText } from "./searchStatusText";
import {
  canCancelSearch,
  cardIdByUrl,
  isDeepSearchRunning,
  isSearchButtonDisabled,
  listingsByUrl,
  setAiFilterPendingRun,
  setIsAiFilterRunning,
  type UrlCardData,
} from "./state";
import {
  addUrlCard,
  removeUrlCardEntry,
  type UrlCard,
  type UrlCardDom,
  urlCardData,
  urlCards,
} from "./urlCardStore";
import { expandUrlGroup, syncUrlGroups, updateUrlGroupHeaders } from "./urlGroupsView";

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
    statusBar.classList.add("hidden");
    return;
  }
  statusBar.className = `url-card-status ${status.kind}`;
  statusBar.innerHTML =
    status.kind === "info"
      ? `<span class="spinner"></span><span>${esc(status.text)}</span>`
      : `<span>${esc(status.text)}</span>`;
  if (canCancelSearch(urlCardData(card).searchStatus)) {
    const cancelButton = document.createElement("button");
    cancelButton.className = "cache-clear-btn";
    cancelButton.style.marginLeft = "0.5rem";
    cancelButton.textContent = "cancel";
    cancelButton.addEventListener("click", () => cancelSearch(card));
    statusBar.appendChild(cancelButton);
  }
  statusBar.classList.remove("hidden");
  updateUrlGroupHeaders();
}

export function cancelSearch(card: UrlCard): void {
  const data = urlCardData(card);
  if (!canCancelSearch(data.searchStatus)) return;
  data.searchStatus = "cancelling";
  renderCardStatus(card);
  fetch("/api/cancel-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ searchId: data.searchId }),
  }).catch(() => null);
}

export function cancelGroupSearches(recipeId: RecipeId): void {
  for (const card of urlCards) {
    if (recipeIdForUrl(card.dom.input.value.trim()) === recipeId) cancelSearch(card);
  }
}

export function handleUrlInputChanged(card: UrlCard): void {
  card.dom.searchButton.disabled = !canSearchCard(card);
  const recipeId = recipeIdForUrl(card.dom.input.value.trim());
  const previousParent = card.dom.containerElement.parentElement;
  syncUrlGroups();
  // A row that just moved into a collapsed group would vanish mid-edit —
  // expand its destination group so the input stays visible.
  if (card.dom.containerElement.parentElement !== previousParent && recipeId !== null)
    expandUrlGroup(recipeId);
}

// Once a search has touched the row, the URL displays as a truncated link;
// the (hidden) input stays the single source of the row's URL value.
export function renderUrlRowMode(card: UrlCard): void {
  const data = urlCardData(card);
  const url = card.dom.input.value.trim();
  const showLink = data.searchStatus !== "idle" || data.wasCancelled || data.searchedUrl !== "";
  card.dom.linkElement.href = url;
  card.dom.linkElement.textContent = url;
  card.dom.linkElement.classList.toggle("hidden", !showLink);
  card.dom.input.classList.toggle("hidden", showLink);
  card.dom.searchButton.classList.toggle("hidden", showLink);
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

// assets/x.svg, inlined so it inherits currentColor.
export const X_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5L19 19M5 19L19 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const SEARCH_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

export function createUrlCard(searchCardAsync: (card: UrlCard) => Promise<void>): UrlCard {
  const cardEl = document.createElement("div");
  cardEl.className = "source-url-row";
  cardEl.innerHTML = `
    <div class="url-row">
      <a class="url-link hidden" target="_blank" rel="noopener noreferrer"></a>
      <input type="url" class="url-input" placeholder="Paste search URL…" />
      <button class="btn icon-btn url-search-btn" type="button" title="Search" disabled>${SEARCH_ICON}</button>
      <button class="btn icon-btn url-remove-btn hidden" type="button" title="Remove">${X_ICON}</button>
    </div>
    <div class="url-card-status hidden"></div>
    <div class="url-criteria hidden"><div class="criteria-grid"></div><div class="cache-status hidden"></div></div>
  `;
  getElement("urlCardsContainer").appendChild(cardEl);

  const input = requireChild<HTMLInputElement>(cardEl, ".url-input");
  const linkElement = requireChild<HTMLAnchorElement>(cardEl, ".url-link");
  const searchButton = requireChild<HTMLButtonElement>(cardEl, ".url-search-btn");
  const removeButton = requireChild<HTMLButtonElement>(cardEl, ".url-remove-btn");
  const criteriaElement = requireChild<HTMLElement>(cardEl, ".url-criteria");
  const cacheStatusElement = requireChild<HTMLElement>(cardEl, ".cache-status");
  const statusElement = requireChild<HTMLElement>(cardEl, ".url-card-status");

  const data: UrlCardData = {
    searchStatus: "idle",
    searchedUrl: "",
    searchId: null,
    listingUrls: [],
    lastProgress: null,
    errorMessage: null,
    wasCancelled: false,
  };
  const dom: UrlCardDom = {
    containerElement: cardEl,
    input,
    linkElement,
    searchButton,
    removeButton,
    criteriaElement,
    cacheStatusElement,
    statusElement,
  };
  const urlCard = addUrlCard(dom, data);

  input.addEventListener("input", () => handleUrlInputChanged(urlCard));
  input.addEventListener("keydown", (keyboardEvent: KeyboardEvent) => {
    if (keyboardEvent.key === "Enter" && canSearchCard(urlCard)) searchCardAsync(urlCard);
  });
  searchButton.addEventListener("click", () => {
    if (canSearchCard(urlCard)) searchCardAsync(urlCard);
  });
  removeButton.addEventListener("click", () => removeUrlCard(urlCard));

  updateRemoveButtons();
  syncUrlGroups();
  return urlCard;
}

export function resetAllResults(): void {
  setIsAiFilterRunning(false);
  setAiFilterPendingRun(false);
  listingsByUrl.clear();
  getElement("listingsContainer").innerHTML = "";
  getElement("resultCount").textContent = "0";
  renderFilteredToggle();
  getElement("filteredCount").classList.add("hidden");
  getElement("resultsSection").classList.add("hidden");
  for (const card of urlCards) {
    const data = urlCardData(card);
    data.listingUrls = [];
    data.searchStatus = "idle";
    data.searchedUrl = "";
    data.lastProgress = null;
    data.errorMessage = null;
    data.wasCancelled = false;
    requireChild<HTMLElement>(card.dom.criteriaElement, ".criteria-grid").innerHTML = "";
    card.dom.criteriaElement.classList.add("hidden");
    card.dom.cacheStatusElement.classList.add("hidden");
    card.dom.cacheStatusElement.innerHTML = "";
    card.dom.statusElement.classList.add("hidden");
    data.searchId = null;
    card.dom.input.readOnly = false;
    renderUrlRowMode(card);
  }
  renderDerived();
}

export function updateRemoveButtons(): void {
  const show = urlCards.length > 1;
  for (const card of urlCards) card.dom.removeButton.classList.toggle("hidden", !show);
}

export function resetCardForResearch(card: UrlCard): void {
  const data = urlCardData(card);
  const otherUrls = new Set(
    urlCards.flatMap((c) => (c === card ? [] : urlCardData(c).listingUrls)),
  );
  for (const url of data.listingUrls) {
    if (!otherUrls.has(url)) {
      getCardByUrl(url)?.remove();
      listingsByUrl.delete(url);
      cardIdByUrl.delete(url);
    }
  }
  data.listingUrls = [];
  data.searchStatus = "idle";
  data.searchedUrl = "";
  data.lastProgress = null;
  data.errorMessage = null;
  data.wasCancelled = false;
  requireChild<HTMLElement>(card.dom.criteriaElement, ".criteria-grid").innerHTML = "";
  card.dom.criteriaElement.classList.add("hidden");
  card.dom.cacheStatusElement.classList.add("hidden");
  card.dom.cacheStatusElement.innerHTML = "";
  card.dom.statusElement.classList.add("hidden");
  card.dom.input.readOnly = false;
  renderUrlRowMode(card);
  if (getOrderedListings().length === 0) getElement("resultsSection").classList.add("hidden");
  renderDerived();
}

export function removeUrlCard(card: UrlCard): void {
  const otherUrls = new Set(
    urlCards.flatMap((c) => (c === card ? [] : urlCardData(c).listingUrls)),
  );
  for (const url of urlCardData(card).listingUrls) {
    if (!otherUrls.has(url)) {
      getCardByUrl(url)?.remove();
      listingsByUrl.delete(url);
      cardIdByUrl.delete(url);
    }
  }
  card.dom.containerElement.remove();
  removeUrlCardEntry(card);
  if (getOrderedListings().length === 0) getElement("resultsSection").classList.add("hidden");
  updateRemoveButtons();
  syncUrlGroups();
  applyClientFilters();
}
