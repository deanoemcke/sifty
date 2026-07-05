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
import { closeListingModal, openListingCardModal, runDeepSearchAsync } from "./listingDetail";
import {
  buildCardMetaHtml,
  buildCardPriceHtml,
  buildDetailMetaHtml,
  buildDetailPriceHtml,
  buildExtrasHtml,
  filterBannerText,
} from "./listingHtml";
import { parseMaxPrice } from "./parseUtils";
import { searchUrlCardAsync } from "./quickSearch";
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
