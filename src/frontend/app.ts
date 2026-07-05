import "./styles.css";

import type { Listing, ListingDetail } from "../lib/recipes/base";
import { isValidRecipeUrl, recipeIdForUrl } from "../lib/recipes/matcher";
import type { RecipeId } from "../lib/recipes/metadata";
import { scheduleAiFilterRun } from "./aiFilter";
import { fireAllCardSearches } from "./cardSearch";
import { decideModalDeepSearchAction } from "./deepSearchTrigger";
import {
  applyLoadedDiscoverInputs,
  DEFAULT_REGION_DISPLAY,
  DISCOVERY_BUTTON_BUSY_LABEL,
  DISCOVERY_BUTTON_LABEL,
  discoveryFormElements,
  fulfillmentFromAllowShipping,
  populateRegionSelect,
  type RegionOption,
  readDiscoverInputs,
  updateDiscoveryBtn,
} from "./discoveryForm";
import { getElement, requireChild } from "./domUtils";
import { collapseElementAsync, expandElement } from "./heightAnimation";
import { esc } from "./html";
import { applyListingCardAccessibility, handleListingCardKeydown } from "./listingCardActivation";
import {
  buildCardMetaHtml,
  buildCardPriceHtml,
  buildDetailMetaHtml,
  buildDetailPriceHtml,
  buildExtrasHtml,
  filterBannerText,
} from "./listingHtml";
import { parseMaxPrice } from "./parseUtils";
import { recipeFaviconHtml, sourceBadgeHtml } from "./recipeDisplay";
import { promptHash, shouldDisableApplyFilterBtn } from "./renderUtils";
import {
  type CardStatusSnapshot,
  cardStatusText,
  parseQuickSearchProgress,
} from "./searchStatusText";
import { activateSidebarTab } from "./sidebarTabs";
import {
  aiFilterPendingRun,
  bulkDeepSearchUrls,
  canCancelSearch,
  cardIdByUrl,
  currentSearchName,
  type DiscoverInputs,
  deepSearchCancellationRequested,
  deepSearchId,
  isAiFilterRunning,
  isCardSearchActive,
  isDeepSearchRunning,
  isSearchButtonDisabled,
  type ListingItem,
  listingsByUrl,
  openModalListingUrl,
  type SavedSearch,
  setAiFilterPendingRun,
  setBulkDeepSearchUrls,
  setCurrentSearchName,
  setDeepSearchCancellationRequested,
  setDeepSearchId,
  setIsAiFilterRunning,
  setIsDeepSearchRunning,
  setOpenModalListingUrl,
  setShowFilteredListings,
  showFilteredListings,
  singleDeepSearchInFlightUrls,
  type UrlCardData,
  type UrlCardSearchStatus,
  urlCardData,
} from "./state";
import { setStatus } from "./statusBar";
import { streamPostAsync } from "./streamPost";
import {
  addUrlCard,
  removeUrlCardEntry,
  type UrlCard,
  type UrlCardDom,
  urlCards,
} from "./urlCardStore";
import { computeUrlGroups, groupHeaderView, type UrlGroupMemberSnapshot } from "./urlGroups";
import {
  expandUrlGroup,
  syncUrlGroups,
  toggleUrlGroup,
  updateUrlGroupHeaders,
} from "./urlGroupsView";

// ── Utility ───────────────────────────────────────────────────────────────────

function cardStatusSnapshot(card: UrlCard): CardStatusSnapshot {
  return {
    searchStatus: card.data.searchStatus,
    lastProgress: card.data.lastProgress,
    listingsFoundCount: card.data.listingUrls.length,
    errorMessage: card.data.errorMessage,
    wasCancelled: card.data.wasCancelled,
  };
}

// Single renderer for the per-row status line — wording derives from the
// card's semantic state via searchStatusText, never from ad-hoc strings.
function renderCardStatus(card: UrlCard): void {
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
  if (canCancelSearch(card.data.searchStatus)) {
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

function cancelSearch(card: UrlCard): void {
  if (!canCancelSearch(card.data.searchStatus)) return;
  card.data.searchStatus = "cancelling";
  renderCardStatus(card);
  fetch("/api/cancel-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ searchId: card.data.searchId }),
  }).catch(() => null);
}

function setDeepSearchingStatus(statusMessage: string): void {
  const statusBar = getElement("statusBar");
  statusBar.className = "status-bar info";
  statusBar.innerHTML = `<span class="spinner"></span><span>${esc(statusMessage)}</span>`;
  if (!deepSearchCancellationRequested) {
    const cancelButton = document.createElement("button");
    cancelButton.className = "cache-clear-btn";
    cancelButton.style.marginLeft = "0.5rem";
    cancelButton.textContent = "cancel";
    cancelButton.addEventListener("click", cancelDeepSearch);
    statusBar.appendChild(cancelButton);
  }
  statusBar.classList.remove("hidden");
}

function cancelDeepSearch(): void {
  if (!isDeepSearchRunning || deepSearchCancellationRequested) return;
  setDeepSearchCancellationRequested(true);
  setDeepSearchingStatus("Cancelling…");
  fetch("/api/cancel-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ searchId: deepSearchId }),
  }).catch(() => null);
}

function handleUrlInputChanged(card: UrlCard): void {
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
function renderUrlRowMode(card: UrlCard): void {
  const url = card.dom.input.value.trim();
  const showLink =
    card.data.searchStatus !== "idle" || card.data.wasCancelled || card.data.searchedUrl !== "";
  card.dom.linkElement.href = url;
  card.dom.linkElement.textContent = url;
  card.dom.linkElement.classList.toggle("hidden", !showLink);
  card.dom.input.classList.toggle("hidden", showLink);
  card.dom.searchButton.classList.toggle("hidden", showLink);
}

function canSearchCard(card: UrlCard): boolean {
  const current = card.dom.input.value.trim();
  return (
    !isDeepSearchRunning &&
    isValidRecipeUrl(current) &&
    !isSearchButtonDisabled(card.data.searchStatus, card.data.searchedUrl, current)
  );
}

function setDeepSearchBusy(busy: boolean): void {
  setIsDeepSearchRunning(busy);
  renderDerived();
}

// assets/x.svg, inlined so it inherits currentColor.
const X_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5L19 19M5 19L19 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const SEARCH_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

function createUrlCard(): UrlCard {
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
  const urlCard: UrlCard = { data, dom };
  addUrlCard(urlCard);

  input.addEventListener("input", () => handleUrlInputChanged(urlCard));
  input.addEventListener("keydown", (keyboardEvent: KeyboardEvent) => {
    if (keyboardEvent.key === "Enter" && canSearchCard(urlCard)) searchUrlCardAsync(urlCard);
  });
  searchButton.addEventListener("click", () => {
    if (canSearchCard(urlCard)) searchUrlCardAsync(urlCard);
  });
  removeButton.addEventListener("click", () => removeUrlCard(urlCard));

  updateRemoveButtons();
  syncUrlGroups();
  return urlCard;
}

// Sole writer of the filtered-results toggle label — derives it from state.
function renderFilteredToggle(): void {
  getElement<HTMLButtonElement>("toggleFilteredBtn").textContent = showFilteredListings
    ? "hide"
    : "show";
}

function resetAllResults(): void {
  setIsAiFilterRunning(false);
  setAiFilterPendingRun(false);
  listingsByUrl.clear();
  getElement("listingsContainer").innerHTML = "";
  getElement("resultCount").textContent = "0";
  renderFilteredToggle();
  getElement("filteredCount").classList.add("hidden");
  getElement("resultsSection").classList.add("hidden");
  for (const card of urlCards) {
    card.data.listingUrls = [];
    card.data.searchStatus = "idle";
    card.data.searchedUrl = "";
    card.data.lastProgress = null;
    card.data.errorMessage = null;
    card.data.wasCancelled = false;
    requireChild<HTMLElement>(card.dom.criteriaElement, ".criteria-grid").innerHTML = "";
    card.dom.criteriaElement.classList.add("hidden");
    card.dom.cacheStatusElement.classList.add("hidden");
    card.dom.cacheStatusElement.innerHTML = "";
    card.dom.statusElement.classList.add("hidden");
    card.data.searchId = null;
    card.dom.input.readOnly = false;
    renderUrlRowMode(card);
  }
  renderDerived();
}

function getOrderedListings(): ListingItem[] {
  const seen = new Set<string>();
  return urlCards
    .flatMap((card) =>
      card.data.listingUrls.filter((listingUrl) => !seen.has(listingUrl) && seen.add(listingUrl)),
    )
    .flatMap((listingUrl) => {
      // Every URL in listingUrls was added to listingsByUrl at the same time in searchUrlCardAsync.
      const listing = listingsByUrl.get(listingUrl);
      return listing ? [listing] : [];
    });
}

function renderDerived(): void {
  const listings = getOrderedListings();
  const visible = listings.filter((listingItem) => listingItem.aiFilterReason === null);
  const filtered = listings.length - visible.length;
  getElement("resultCount").textContent = String(visible.length);
  getElement("filteredCountNum").textContent = String(filtered);
  getElement("filteredCount").classList.toggle("hidden", filtered === 0);
  const isAnyCardSearching = urlCards.some((card) => isCardSearchActive(card.data.searchStatus));
  const hasUnscraped = visible.some((listingItem) => !listingItem.hasBeenDeepSearched);
  getElement("deepBtn").classList.toggle(
    "hidden",
    isDeepSearchRunning || isAnyCardSearching || !hasUnscraped,
  );
  const prompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
  const hash = promptHash(prompt);
  const isFilterCurrent =
    !prompt ||
    listings.length === 0 ||
    listings.every((listingItem) => listingItem.aiCheckedHash === hash);
  const applyFilterBtn = getElement<HTMLButtonElement>("applyAiFilterBtn");
  applyFilterBtn.disabled = shouldDisableApplyFilterBtn({ isFilterCurrent, isAiFilterRunning });
  updateUrlGroupHeaders();
}

function updateRemoveButtons(): void {
  const show = urlCards.length > 1;
  for (const card of urlCards) card.dom.removeButton.classList.toggle("hidden", !show);
}

function resetCardForResearch(card: UrlCard): void {
  const otherUrls = new Set(urlCards.flatMap((c) => (c === card ? [] : c.data.listingUrls)));
  for (const url of card.data.listingUrls) {
    if (!otherUrls.has(url)) {
      getCardByUrl(url)?.remove();
      listingsByUrl.delete(url);
      cardIdByUrl.delete(url);
    }
  }
  card.data.listingUrls = [];
  card.data.searchStatus = "idle";
  card.data.searchedUrl = "";
  card.data.lastProgress = null;
  card.data.errorMessage = null;
  card.data.wasCancelled = false;
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

function removeUrlCard(card: UrlCard): void {
  const otherUrls = new Set(urlCards.flatMap((c) => (c === card ? [] : c.data.listingUrls)));
  for (const url of card.data.listingUrls) {
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

async function searchUrlCardAsync(card: UrlCard): Promise<void> {
  const url = card.dom.input.value.trim();
  if (!isValidRecipeUrl(url)) return;

  if (card.data.searchStatus === "done") resetCardForResearch(card);

  getElement("resultsSection").classList.remove("hidden");
  card.data.searchStatus = "searching";
  card.data.searchId = crypto.randomUUID();
  card.data.lastProgress = null;
  card.data.errorMessage = null;
  card.data.wasCancelled = false;
  renderDerived();
  renderCardStatus(card);

  let cachedAge = "";
  try {
    await streamPostAsync("/api/quick-search", { url, searchId: card.data.searchId }, (ev) => {
      if (ev.type === "criteria") {
        const filters = ev.filters as Array<[string, string]>;
        requireChild<HTMLElement>(card.dom.criteriaElement, ".criteria-grid").innerHTML = filters
          .map(
            ([k, v]) =>
              `<div class="criteria-row"><span class="criteria-key">${esc(k)}</span><span class="criteria-val">${esc(v)}</span></div>`,
          )
          .join("");
        card.dom.criteriaElement.classList.remove("hidden");
      } else if (ev.type === "cached") {
        cachedAge = ev.age as string;
      } else if (ev.type === "progress") {
        const progress = parseQuickSearchProgress(ev);
        if (progress === null) {
          console.warn("Ignoring malformed progress event", ev);
        } else {
          card.data.lastProgress = progress;
          if (canCancelSearch(card.data.searchStatus)) renderCardStatus(card);
          updateUrlGroupHeaders();
        }
      } else if (ev.type === "listing") {
        const listing = ev.data as Listing;
        card.data.listingUrls.push(listing.url);
        if (!listingsByUrl.has(listing.url)) {
          const item: ListingItem = {
            data: listing,
            detail: null,
            hasBeenDeepSearched: false,
            aiCheckedHash: null,
            aiFilterReason: null,
          };
          listingsByUrl.set(listing.url, item);
          renderCard(item);
          renderDerived();
        } else {
          // Listing already known from another card — the group count may
          // still change, since it dedupes per group rather than globally.
          updateUrlGroupHeaders();
        }
      } else if (ev.type === "error") {
        card.data.errorMessage = typeof ev.message === "string" ? ev.message : "Search failed";
      }
    });
  } catch (error) {
    card.data.errorMessage = (error as Error).message;
  }

  const wasCancelled = (card.data.searchStatus as UrlCardSearchStatus) === "cancelling";
  card.data.searchStatus = wasCancelled ? "idle" : "done";
  card.data.searchId = null;

  if (wasCancelled) {
    card.data.wasCancelled = true;
    renderCardStatus(card);
    if (listingsByUrl.size > 0) applyClientFilters();
    return;
  }
  card.data.searchedUrl = url;
  card.dom.input.readOnly = true;

  if (cachedAge) {
    card.dom.cacheStatusElement.innerHTML = `Loaded from cache — ${esc(cachedAge)} <button class="cache-clear-btn">Clear</button>`;
    card.dom.cacheStatusElement.classList.remove("hidden");
    requireChild<HTMLButtonElement>(
      card.dom.cacheStatusElement,
      ".cache-clear-btn",
    ).addEventListener("click", clearQuickSearchCacheAsync);
  }

  renderCardStatus(card);
  if (listingsByUrl.size > 0) {
    applyClientFilters();
    const aiPrompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
    if (aiPrompt)
      scheduleAiFilterRun({ isAiFilterRunning, runAiFilterAsync, setAiFilterPendingRun });
  } else {
    renderDerived();
  }
}

// ── Client-side filtering ─────────────────────────────────────────────────────

function applyClientFilters(): void {
  for (const item of getOrderedListings()) {
    const passes = item.aiFilterReason === null;
    const card = getCardByUrl(item.data.url);
    if (card) {
      const banner = requireChild<HTMLElement>(card, ".filter-banner");
      if (passes) {
        card.style.display = "";
        card.classList.remove("filtered-out");
        banner.textContent = "";
        banner.classList.add("hidden");
      } else {
        card.classList.add("filtered-out");
        banner.textContent = filterBannerText(item);
        banner.classList.remove("hidden");
        card.style.display = showFilteredListings ? "" : "none";
      }
    }
  }
  renderDerived();
}

async function runAiFilterAsync(): Promise<void> {
  if (isAiFilterRunning) {
    setAiFilterPendingRun(true);
    return;
  }

  const prompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
  if (!prompt) return;
  const hash = promptHash(prompt);
  const toCheck = getOrderedListings().filter((item) => item.aiCheckedHash !== hash);
  if (toCheck.length === 0) return;

  setIsAiFilterRunning(true);
  renderDerived();

  let checked = 0;
  let streamError: string | null = null;

  try {
    await streamPostAsync(
      "/api/ai-filter",
      {
        prompt,
        listings: toCheck.map((item) => ({
          url: item.data.url,
          title: item.data.title,
          price: item.data.priceDisplay,
          location: item.data.location,
          description: (item.detail?.description ?? item.data.description)?.slice(0, 300) ?? "",
        })),
      },
      (event) => {
        if (event.type === "result") {
          for (const result of event.results as Array<{
            url: string;
            pass: boolean;
            reason: string | null;
          }>) {
            const item = listingsByUrl.get(result.url);
            if (item) {
              item.aiCheckedHash = hash;
              item.aiFilterReason = result.pass ? null : (result.reason ?? "No reason given");
              checked++;
            }
          }
          applyClientFilters();
        } else if (event.type === "error") {
          streamError = event.message as string;
        }
      },
    );
    if (streamError) throw new Error(streamError);
  } catch (error) {
    setStatus((error as Error).message, "error");
  } finally {
    setIsAiFilterRunning(false);
    renderDerived();
    if (aiFilterPendingRun) {
      setAiFilterPendingRun(false);
      void runAiFilterAsync();
    }
  }
}

async function clearQuickSearchCacheAsync(): Promise<void> {
  await fetch("/api/cache/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "quick-search" }),
  }).catch(() => null);
  resetAllResults();
}

// ── Card helpers ──────────────────────────────────────────────────────────────

// Looks up a listing card by URL. Returns null if not yet rendered.
function getCardByUrl(url: string): HTMLElement | null {
  const id = cardIdByUrl.get(url);
  return id ? document.getElementById(id) : null;
}

function renderCard(item: ListingItem): void {
  const listing = item.data;

  // Assign a UUID-based id on first render; reuse it on re-renders.
  let cardId = cardIdByUrl.get(listing.url);
  if (!cardId) {
    cardId = `card-${crypto.randomUUID()}`;
    cardIdByUrl.set(listing.url, cardId);
  }

  const existing = document.getElementById(cardId);
  const card = existing ?? document.createElement("div");
  card.className = "listing-card";
  card.id = cardId;
  card.dataset.url = listing.url;
  applyListingCardAccessibility(card, listing.title);

  const thumb = listing.thumbnailUrl
    ? `<img class="listing-thumb" src="${esc(listing.thumbnailUrl)}" alt="" loading="lazy">`
    : `<div class="listing-thumb-placeholder">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
       </div>`;

  // The card never re-renders once a deep search populates item.detail — all
  // detail-derived content (badges, buy-now price, extras) lives in the modal
  // only, so this template deliberately never references item.detail.
  card.innerHTML = `
    <div class="listing-card-content">
      <div class="listing-thumb-wrap">
        ${thumb}
        ${sourceBadgeHtml(listing.source, 28)}
      </div>
      <div class="listing-body">
        <div class="listing-meta">
          ${buildCardMetaHtml(listing)}
        </div>
        <div class="listing-title" title="${esc(listing.title)}">${esc(listing.title)}</div>
        <div class="listing-prices">
          ${buildCardPriceHtml(listing)}
        </div>
      </div>
    </div>
    <div class="filter-banner hidden"></div>
  `;

  if (!existing) getElement("listingsContainer").appendChild(card);
}

// ── Listing detail modal ──────────────────────────────────────────────────────

function listingModalExtrasHtml(item: ListingItem, errorMessage: string | null): string {
  if (errorMessage) return `<p class="deep-empty">Couldn't load details — ${esc(errorMessage)}</p>`;
  if (item.detail) return buildExtrasHtml(item.detail);
  return `<div class="modal-loading"><span class="spinner"></span><span>Fetching details…</span></div>`;
}

function renderListingModalContent(item: ListingItem, errorMessage: string | null = null): void {
  // A previous single-listing fetch may resolve after the modal has closed
  // or moved on to a different listing — ignore stale writes.
  if (openModalListingUrl !== item.data.url) return;

  const listing = item.data;
  const thumb = listing.thumbnailUrl
    ? `<img class="listing-modal-thumb" src="${esc(listing.thumbnailUrl)}" alt="">`
    : `<div class="listing-modal-thumb-placeholder"></div>`;
  const metaHtml = item.detail
    ? buildDetailMetaHtml(listing, item.detail)
    : buildCardMetaHtml(listing);
  const priceHtml = item.detail
    ? buildDetailPriceHtml(listing, item.detail)
    : buildCardPriceHtml(listing);

  getElement("listingModalBody").innerHTML = `
    <div class="listing-modal-header">
      <div class="listing-modal-thumb-wrap">${thumb}${sourceBadgeHtml(listing.source, 32)}</div>
      <div class="listing-modal-heading">
        <div class="listing-modal-title">${esc(listing.title)}</div>
        <div class="listing-meta">${metaHtml}</div>
        <div class="listing-prices">${priceHtml}</div>
        <a class="listing-modal-original-link" href="${esc(listing.url)}" target="_blank" rel="noopener">View original listing ↗</a>
      </div>
    </div>
    <div class="listing-modal-extras">${listingModalExtrasHtml(item, errorMessage)}</div>
  `;
}

function applyDeepSearchDetail(item: ListingItem, detail: ListingDetail): void {
  item.hasBeenDeepSearched = true;
  item.detail = detail;
  item.aiCheckedHash = null;
  if (openModalListingUrl === item.data.url) renderListingModalContent(item);
}

async function deepSearchListingAsync(item: ListingItem): Promise<void> {
  const url = item.data.url;
  singleDeepSearchInFlightUrls.add(url);
  try {
    await streamPostAsync(
      "/api/deep-search",
      { listings: [item.data], deepSearchId: crypto.randomUUID() },
      (ev) => {
        if (ev.type === "detail") {
          applyDeepSearchDetail(item, ev.detail as ListingDetail);
          renderDerived();
        } else if (ev.type === "error") {
          renderListingModalContent(item, ev.message as string);
        }
      },
    );
  } catch (error) {
    renderListingModalContent(item, (error as Error).message);
  } finally {
    singleDeepSearchInFlightUrls.delete(url);
  }
  if (item.hasBeenDeepSearched) {
    applyClientFilters();
    const aiPrompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
    if (aiPrompt)
      scheduleAiFilterRun({ isAiFilterRunning, runAiFilterAsync, setAiFilterPendingRun });
  }
}

async function openListingModalAsync(item: ListingItem): Promise<void> {
  setOpenModalListingUrl(item.data.url);
  getElement("listingModal").classList.remove("hidden");
  renderListingModalContent(item);
  const action = decideModalDeepSearchAction({
    hasBeenDeepSearched: item.hasBeenDeepSearched,
    isCoveredByBulkSearch: bulkDeepSearchUrls?.has(item.data.url) ?? false,
    isAlreadyFetchingSingle: singleDeepSearchInFlightUrls.has(item.data.url),
  });
  if (action === "start") await deepSearchListingAsync(item);
}

function closeListingModal(): void {
  getElement("listingModal").classList.add("hidden");
  setOpenModalListingUrl(null);
}

// ── Search ────────────────────────────────────────────────────────────────────

// ── Deep Search ───────────────────────────────────────────────────────────────

async function runDeepSearchAsync(): Promise<void> {
  const toScrape = getOrderedListings()
    .filter(
      (item) =>
        !item.hasBeenDeepSearched &&
        item.aiFilterReason === null &&
        !singleDeepSearchInFlightUrls.has(item.data.url),
    )
    .map((item) => item.data);

  if (toScrape.length === 0) return;

  setDeepSearchId(crypto.randomUUID());
  setDeepSearchCancellationRequested(false);
  setDeepSearchBusy(true);
  setBulkDeepSearchUrls(new Set(toScrape.map((listing) => listing.url)));
  let detailsReceived = 0;

  setDeepSearchingStatus(
    `Fetching details for ${toScrape.length} listing${toScrape.length !== 1 ? "s" : ""}…`,
  );

  try {
    await streamPostAsync("/api/deep-search", { listings: toScrape, deepSearchId }, (ev) => {
      if (ev.type === "progress") {
        if (!deepSearchCancellationRequested)
          setDeepSearchingStatus(
            `Fetching details ${ev.index}/${ev.total} — ${String(ev.title).slice(0, 55)}…`,
          );
      } else if (ev.type === "detail") {
        detailsReceived++;
        const item = listingsByUrl.get(ev.url as string);
        if (item) applyDeepSearchDetail(item, ev.detail as ListingDetail);
        renderDerived();
      } else if (ev.type === "complete") {
        setStatus("Deep search complete", "success");
        setTimeout(() => setStatus(null), 4000);
      } else if (ev.type === "error") {
        setStatus(ev.message as string, "error");
      }
    });
  } catch (error) {
    setStatus((error as Error).message, "error");
  }

  setBulkDeepSearchUrls(null);

  if (deepSearchCancellationRequested) {
    setStatus(
      `Cancelled — ${detailsReceived}/${toScrape.length} detail${toScrape.length !== 1 ? "s" : ""} loaded`,
      "error",
    );
  }

  setDeepSearchId(null);
  setDeepSearchCancellationRequested(false);
  setDeepSearchBusy(false);
  applyClientFilters();
  const aiPrompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
  if (aiPrompt) scheduleAiFilterRun({ isAiFilterRunning, runAiFilterAsync, setAiFilterPendingRun });
}

function markDirty(): void {
  getElement("saveCurrentBtn").classList.remove("hidden");
}

function setSearchName(name: string | null): void {
  setCurrentSearchName(name);
  getElement("saveCurrentBtn").classList.add("hidden");
}

// ── Saved searches ────────────────────────────────────────────────────────────

async function fetchSavedSearchesAsync(): Promise<void> {
  try {
    const response = await fetch("/api/saved-searches", { cache: "no-store" });
    const data = (await response.json()) as { searches: SavedSearch[] };
    renderSavedSearches(data.searches);
  } catch {
    /* non-critical */
  }
}

function renderSavedSearches(searches: SavedSearch[]): void {
  const list = getElement("savedSearchesList");
  const count = getElement("savedSearchesCount");

  count.textContent = String(searches.length);
  count.classList.toggle("hidden", searches.length === 0);

  if (searches.length === 0) {
    list.innerHTML = '<p class="deep-empty">No favourites yet.</p>';
    return;
  }
  list.innerHTML = searches
    .map(
      (savedSearch) => `
    <div class="saved-search-row" data-id="${esc(savedSearch.id)}">
      <a class="saved-search-name load-saved-btn" href="#" title="${esc(savedSearch.name)}">${esc(savedSearch.name)}</a>
      <button class="btn icon-btn delete-saved-btn" type="button" title="Delete">${X_ICON}</button>
    </div>
  `,
    )
    .join("");
}

async function saveCurrentSearchAsync(name: string): Promise<void> {
  const urls = urlCards.map((card) => card.dom.input.value.trim()).filter(Boolean);
  if (!name.trim() || urls.length === 0) return;
  const response = await fetch("/api/saved-searches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name.trim(),
      urls,
      discoverInputs: readDiscoverInputs(),
      aiFilter: getElement<HTMLTextAreaElement>("aiFilter").value.trim() || null,
    }),
  });
  if (response.ok) await fetchSavedSearchesAsync();
}

async function deleteSavedSearchAsync(id: string): Promise<void> {
  await fetch(`/api/saved-searches/${id}`, { method: "DELETE" });
  await fetchSavedSearchesAsync();
}

// The URL cards and AI filter stay hidden until the first search of the
// session — either a discovery run or loading a favourite.
function revealSearchConfig(): void {
  getElement("searchConfigSection").classList.remove("hidden");
}

function loadDiscoveryResults(data: { urls: string[]; name: string }, aiPrompt: string): void {
  revealSearchConfig();
  resetAllResults();
  while (urlCards.length > 1) removeUrlCard(urlCards[urlCards.length - 1]);
  urlCards[0].dom.input.value = data.urls[0];
  for (let urlIndex = 1; urlIndex < data.urls.length; urlIndex++) {
    createUrlCard().dom.input.value = data.urls[urlIndex];
  }
  for (const card of urlCards) handleUrlInputChanged(card);
  setSearchName(data.name);
  markDirty();
  getElement<HTMLTextAreaElement>("aiFilter").value = aiPrompt;
  // loadDiscoveryResults owns the dispatch: kick off a search for every configured card.
  fireAllCardSearches(urlCards, searchUrlCardAsync);
}

async function loadSavedSearchAsync(search: SavedSearch): Promise<void> {
  revealSearchConfig();
  resetAllResults();
  while (urlCards.length > 1) removeUrlCard(urlCards[urlCards.length - 1]);
  applyLoadedDiscoverInputs(discoveryFormElements(), search.discoverInputs);
  if (search.urls.length === 0) return;
  urlCards[0].dom.input.value = search.urls[0];
  for (let urlIndex = 1; urlIndex < search.urls.length; urlIndex++) {
    createUrlCard().dom.input.value = search.urls[urlIndex];
  }
  for (const card of urlCards) handleUrlInputChanged(card);
  getElement<HTMLTextAreaElement>("aiFilter").value = search.aiFilter ?? "";
  setSearchName(search.name);
  activateSidebarTab(document, "search");
  // loadSavedSearchAsync owns the dispatch: kick off a search for every configured card.
  fireAllCardSearches(urlCards, searchUrlCardAsync);
}

// ── Event listeners ───────────────────────────────────────────────────────────

function initApp(): void {
  getElement("discoveryBtn").textContent = DISCOVERY_BUTTON_LABEL;
  renderFilteredToggle();
  createUrlCard();
  getElement<HTMLTextAreaElement>("discoveryPrompt").focus();

  getElement("addUrlBtn").addEventListener("click", () => {
    const newCard = createUrlCard();
    newCard.dom.input.focus();
    newCard.dom.containerElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  getElement<HTMLButtonElement>("deepBtn").addEventListener("click", () => runDeepSearchAsync());

  getElement("toggleFilteredBtn").addEventListener("click", () => {
    setShowFilteredListings(!showFilteredListings);
    renderFilteredToggle();
    for (const item of getOrderedListings()) {
      if (item.aiFilterReason !== null) {
        const card = getCardByUrl(item.data.url);
        if (card) card.style.display = showFilteredListings ? "" : "none";
      }
    }
  });

  // Populate region dropdown and wire the allow-shipping checkbox
  fetch("/api/regions")
    .then((regionResponse) => regionResponse.json())
    .then((regions: RegionOption[]) => {
      populateRegionSelect(
        getElement<HTMLSelectElement>("discoveryRegion"),
        regions,
        DEFAULT_REGION_DISPLAY,
      );
      updateDiscoveryBtn();
    })
    .catch(() => {
      /* regions unavailable — dropdown stays empty */
    });

  getElement<HTMLInputElement>("discoveryAllowShipping").addEventListener(
    "change",
    updateDiscoveryBtn,
  );
  getElement<HTMLSelectElement>("discoveryRegion").addEventListener("change", updateDiscoveryBtn);

  getElement<HTMLTextAreaElement>("discoveryPrompt").addEventListener("input", updateDiscoveryBtn);
  getElement<HTMLInputElement>("discoveryMaxPrice").addEventListener("input", updateDiscoveryBtn);
  getElement<HTMLButtonElement>("discoveryBtn").addEventListener("click", async () => {
    const prompt = getElement<HTMLTextAreaElement>("discoveryPrompt").value.trim();
    if (!prompt) return;
    const maxPrice = parseMaxPrice(getElement<HTMLInputElement>("discoveryMaxPrice").value);
    const fulfillment = fulfillmentFromAllowShipping(
      getElement<HTMLInputElement>("discoveryAllowShipping").checked,
    );
    const regionValue = getElement<HTMLSelectElement>("discoveryRegion").value || undefined;
    const discoveryButton = getElement<HTMLButtonElement>("discoveryBtn");
    const discoveryErrorElement = getElement<HTMLDivElement>("discoveryError");
    discoveryErrorElement.style.display = "none";
    discoveryButton.disabled = true;
    discoveryButton.textContent = DISCOVERY_BUTTON_BUSY_LABEL;
    try {
      const response = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, maxPrice, fulfillment, regionValue }),
      });
      const data = (await response.json()) as {
        urls?: string[];
        name?: string;
        error?: string;
      };
      if (!response.ok || !data.urls?.length) {
        discoveryErrorElement.textContent = data.error ?? "Discovery failed";
        discoveryErrorElement.style.display = "block";
        return;
      }
      loadDiscoveryResults(data as { urls: string[]; name: string }, prompt);
    } catch {
      discoveryErrorElement.textContent = "Discovery failed";
      discoveryErrorElement.style.display = "block";
    } finally {
      discoveryButton.textContent = DISCOVERY_BUTTON_LABEL;
      updateDiscoveryBtn();
    }
  });

  getElement<HTMLTextAreaElement>("aiFilter").addEventListener("input", renderDerived);
  getElement<HTMLTextAreaElement>("aiFilter").addEventListener("input", markDirty);
  getElement<HTMLButtonElement>("applyAiFilterBtn").addEventListener("click", () =>
    scheduleAiFilterRun({ isAiFilterRunning, runAiFilterAsync, setAiFilterPendingRun }),
  );

  // Mark dirty on any URL input change or new URL card
  getElement("urlCardsContainer").addEventListener("input", markDirty);
  getElement("addUrlBtn").addEventListener("click", markDirty);

  // Recipe group headers: chevron toggles the rows, cancel stops all of the
  // group's running searches.
  getElement("urlCardsContainer").addEventListener("click", (mouseEvent: MouseEvent) => {
    const groupEl = (mouseEvent.target as HTMLElement).closest<HTMLElement>(".url-group");
    if (!groupEl) return;
    const recipeId = Number(groupEl.dataset.recipeId) as RecipeId;
    if ((mouseEvent.target as HTMLElement).closest(".url-group-toggle")) {
      toggleUrlGroup(recipeId);
      return;
    }
    if ((mouseEvent.target as HTMLElement).closest(".url-group-cancel")) {
      for (const card of urlCards) {
        if (recipeIdForUrl(card.dom.input.value.trim()) === recipeId) cancelSearch(card);
      }
    }
  });

  // Clicking anywhere on a listing card — or pressing Enter/Space on a
  // focused one — opens its detail modal, deep searching it first if it
  // hasn't been already.
  function openListingCardModal(card: HTMLElement): void {
    const url = card.dataset.url;
    if (!url) throw new Error("listing-card missing data-url attribute");
    const item = listingsByUrl.get(url);
    if (!item) throw new Error(`listingsByUrl missing entry for ${url}`);
    void openListingModalAsync(item);
  }

  getElement("listingsContainer").addEventListener("click", (mouseEvent: MouseEvent) => {
    const card = (mouseEvent.target as HTMLElement).closest<HTMLElement>(".listing-card");
    if (!card) return;
    openListingCardModal(card);
  });

  getElement("listingsContainer").addEventListener("keydown", (keyboardEvent: KeyboardEvent) =>
    handleListingCardKeydown(keyboardEvent, openListingCardModal),
  );

  // ── Sidebar tabs / saved searches UI ──────────────────────────────────────────

  getElement("searchTabBtn").addEventListener("click", () =>
    activateSidebarTab(document, "search"),
  );
  getElement("favouritesTabBtn").addEventListener("click", () => {
    activateSidebarTab(document, "favourites");
    fetchSavedSearchesAsync();
  });
  // Populate the tab's count badge without waiting for the first tab switch.
  fetchSavedSearchesAsync();

  function openSaveModal(): void {
    const input = getElement<HTMLInputElement>("saveSearchName");
    input.value = currentSearchName ?? "";
    input.select();
    getElement("saveSearchModal").classList.remove("hidden");
    input.focus();
  }

  function closeSaveModal(): void {
    getElement("saveSearchModal").classList.add("hidden");
  }

  getElement("saveCurrentBtn").addEventListener("click", openSaveModal);

  getElement("saveSearchCancelBtn").addEventListener("click", closeSaveModal);

  getElement("saveSearchModal").addEventListener("click", (mouseEvent: MouseEvent) => {
    if (mouseEvent.target === getElement("saveSearchModal")) closeSaveModal();
  });

  getElement("saveSearchConfirmBtn").addEventListener("click", async () => {
    const name = getElement<HTMLInputElement>("saveSearchName").value.trim();
    if (!name) return;
    const confirmButton = getElement<HTMLButtonElement>("saveSearchConfirmBtn");
    confirmButton.disabled = true;
    await saveCurrentSearchAsync(name);
    setSearchName(name);
    closeSaveModal();
    confirmButton.disabled = false;
    activateSidebarTab(document, "favourites");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  getElement<HTMLInputElement>("saveSearchName").addEventListener(
    "keydown",
    (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Enter")
        getElement<HTMLButtonElement>("saveSearchConfirmBtn").click();
      if (keyboardEvent.key === "Escape") closeSaveModal();
    },
  );

  getElement("listingModalCloseBtn").addEventListener("click", closeListingModal);

  getElement("listingModal").addEventListener("click", (mouseEvent: MouseEvent) => {
    if (mouseEvent.target === getElement("listingModal")) closeListingModal();
  });

  document.addEventListener("keydown", (keyboardEvent: KeyboardEvent) => {
    if (
      keyboardEvent.key === "Escape" &&
      !getElement("listingModal").classList.contains("hidden")
    ) {
      closeListingModal();
    }
  });

  getElement("savedSearchesList").addEventListener("click", async (mouseEvent: MouseEvent) => {
    const row = (mouseEvent.target as HTMLElement).closest<HTMLElement>(".saved-search-row");
    if (!row) return;
    const savedSearchId = row.dataset.id;
    if (!savedSearchId) throw new Error("saved-search-row missing data-id attribute");
    if ((mouseEvent.target as HTMLElement).closest(".delete-saved-btn")) {
      await deleteSavedSearchAsync(savedSearchId);
      return;
    }
    if ((mouseEvent.target as HTMLElement).closest(".load-saved-btn")) {
      mouseEvent.preventDefault();
      const response = await fetch(`/api/saved-searches/${savedSearchId}`);
      if (!response.ok) return;
      const { search } = (await response.json()) as { search: SavedSearch };
      await loadSavedSearchAsync(search);
    }
  });
}

initApp();
