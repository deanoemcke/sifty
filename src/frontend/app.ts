import "./styles.css";

import type { Listing, ListingDetail } from "../lib/recipes/base";
import { isValidRecipeUrl, recipeIdForUrl } from "../lib/recipes/matcher";
import type { RecipeId } from "../lib/recipes/metadata";
import { requestAiFilterRun } from "./aiFilter";
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
import { promptHash } from "./renderUtils";
import {
  applyClientFilters,
  getCardByUrl,
  getOrderedListings,
  renderCard,
  renderDerived,
  renderFilteredToggle,
} from "./resultsView";
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
  cancelSearch,
  createUrlCard,
  handleUrlInputChanged,
  removeUrlCard,
  renderCardStatus,
  resetAllResults,
  resetCardForResearch,
  X_ICON,
} from "./urlCardRow";
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

function setDeepSearchBusy(busy: boolean): void {
  setIsDeepSearchRunning(busy);
  renderDerived();
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
    if (aiPrompt) requestAiFilterRun();
  } else {
    renderDerived();
  }
}

// ── Client-side filtering ─────────────────────────────────────────────────────

async function clearQuickSearchCacheAsync(): Promise<void> {
  await fetch("/api/cache/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "quick-search" }),
  }).catch(() => null);
  resetAllResults();
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
    if (aiPrompt) requestAiFilterRun();
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
  if (aiPrompt) requestAiFilterRun();
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
    createUrlCard(searchUrlCardAsync).dom.input.value = data.urls[urlIndex];
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
    createUrlCard(searchUrlCardAsync).dom.input.value = search.urls[urlIndex];
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
  createUrlCard(searchUrlCardAsync);
  getElement<HTMLTextAreaElement>("discoveryPrompt").focus();

  getElement("addUrlBtn").addEventListener("click", () => {
    const newCard = createUrlCard(searchUrlCardAsync);
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
    requestAiFilterRun(),
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
