import "./styles.css";

import type { Listing, ListingDetail } from "../lib/recipes/base";
import { isValidRecipeUrl, recipeIdForUrl } from "../lib/recipes/matcher";
import type { RecipeId } from "../lib/recipes/metadata";
import { collapseElementAsync, expandElement } from "./heightAnimation";
import { scheduleAiFilterRun } from "./aiFilter";
import { collapseExtras, expandExtras } from "./cardExtras";
import {
  allowShippingFromFulfillment,
  fulfillmentFromAllowShipping,
  populateRegionSelect,
  type RegionOption,
} from "./discoveryForm";
import { shouldDisableUpdateBtn } from "./renderUtils";
import { fireAllCardSearches } from "./cardSearch";
import { getElement, requireChild } from "./domUtils";
import { esc } from "./html";
import { parseMaxPrice } from "./parseUtils";
import { recipeFaviconHtml, sourceFaviconHtml } from "./recipeDisplay";
import {
  type CardStatusSnapshot,
  cardStatusText,
  parseQuickSearchProgress,
} from "./searchStatusText";
import { computeUrlGroups, groupHeaderView, type UrlGroupMemberSnapshot } from "./urlGroups";
import { activateSidebarTab } from "./sidebarTabs";
import {
  aiFilterPendingRun,
  canCancelSearch,
  cardIdByUrl,
  currentSearchName,
  deepSearchCancellationRequested,
  deepSearchId,
  type DiscoverInputs,
  isAiFilterRunning,
  isCardSearchActive,
  isDeepSearchRunning,
  isSearchButtonDisabled,
  type ListingItem,
  listingsByUrl,
  type SavedSearch,
  setAiFilterPendingRun,
  setCurrentSearchName,
  setDeepSearchCancellationRequested,
  setDeepSearchId,
  setIsAiFilterRunning,
  setIsDeepSearchRunning,
  setShowFilteredListings,
  showFilteredListings,
  type UrlCardData,
  type UrlCardSearchStatus,
  urlCardData,
} from "./state";

// ── URL card DOM handles ──────────────────────────────────────────────────────
// UrlCardData (serialisable state) lives in state.ts; DOM refs live here only.

interface UrlCardDom {
  containerElement: HTMLElement;
  input: HTMLInputElement;
  // Truncated hyperlink shown in place of the input once a search has run.
  linkElement: HTMLAnchorElement;
  removeButton: HTMLButtonElement;
  // Criteria block below the status line; hidden until criteria arrive.
  criteriaElement: HTMLElement;
  cacheStatusElement: HTMLElement;
  statusElement: HTMLElement;
}

type UrlCard = { data: UrlCardData; dom: UrlCardDom };
const urlCards: UrlCard[] = [];

// ── Utility ───────────────────────────────────────────────────────────────────

// Region search intent defaults to the user's home region; matched against the
// display names served by /api/regions so region ids stay a server-side detail.
const DEFAULT_REGION_DISPLAY = "Wellington";

function promptHash(inputString: string): number {
  let h = 5381;
  for (let charIndex = 0; charIndex < inputString.length; charIndex++)
    h = ((h * 33) ^ inputString.charCodeAt(charIndex)) >>> 0;
  return h;
}

function readDiscoverInputs(): DiscoverInputs {
  return {
    prompt: getElement<HTMLTextAreaElement>("discoveryPrompt").value.trim(),
    maxPrice: parseMaxPrice(getElement<HTMLInputElement>("discoveryMaxPrice").value),
    fulfillment: fulfillmentFromAllowShipping(
      getElement<HTMLInputElement>("discoveryAllowShipping").checked,
    ),
    region: getElement<HTMLSelectElement>("discoveryRegion").value || undefined,
  };
}

function applyDiscoverInputs(inputs: DiscoverInputs | undefined): void {
  if (!inputs) return;
  getElement<HTMLTextAreaElement>("discoveryPrompt").value = inputs.prompt ?? "";
  getElement<HTMLInputElement>("discoveryMaxPrice").value =
    inputs.maxPrice != null ? String(inputs.maxPrice) : "";
  getElement<HTMLInputElement>("discoveryAllowShipping").checked = allowShippingFromFulfillment(
    inputs.fulfillment,
  );
  // No region in the saved inputs keeps the current selection (Wellington default).
  if (inputs.region) getElement<HTMLSelectElement>("discoveryRegion").value = inputs.region;
  updateDiscoveryBtn();
}

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

function setStatus(
  statusMessage: string | null,
  type: "info" | "success" | "error" = "info",
): void {
  const statusBar = getElement("statusBar");
  if (!statusMessage) {
    statusBar.classList.add("hidden");
    return;
  }
  statusBar.className = `status-bar ${type}`;
  statusBar.innerHTML =
    type === "info"
      ? `<span class="spinner"></span><span>${esc(statusMessage)}</span>`
      : `<span>${esc(statusMessage)}</span>`;
  statusBar.classList.remove("hidden");
}

function handleUrlInputChanged(card: UrlCard): void {
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
}

// ── URL recipe groups ─────────────────────────────────────────────────────────

const CHEVRON_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

const urlGroupExpandedByRecipeId = new Map<RecipeId, boolean>();

function urlGroupMemberSnapshot(card: UrlCard): UrlGroupMemberSnapshot {
  return {
    url: card.dom.input.value.trim(),
    searchStatus: card.data.searchStatus,
    listingUrls: card.data.listingUrls,
  };
}

function findUrlGroupElement(recipeId: RecipeId): HTMLElement | null {
  return getElement("urlCardsContainer").querySelector<HTMLElement>(
    `.url-group[data-recipe-id="${recipeId}"]`,
  );
}

function buildUrlGroupElement(recipeId: RecipeId): HTMLElement {
  const groupEl = document.createElement("div");
  groupEl.className = "url-group";
  groupEl.dataset.recipeId = String(recipeId);
  groupEl.innerHTML = `
    <div class="url-group-header">
      ${recipeFaviconHtml(recipeId)}
      <span class="url-group-status"></span>
      <button class="cache-clear-btn url-group-cancel hidden" type="button">cancel</button>
      <button class="btn icon-btn url-group-toggle" type="button" title="Show URLs">${CHEVRON_ICON}</button>
    </div>
    <div class="url-group-rows hidden"></div>
  `;
  return groupEl;
}

// Reconciles the group containers with the cards' current recipes: groups are
// kept in recipe-id order at the top, unmatched rows stay loose below them.
function syncUrlGroups(): void {
  const container = getElement("urlCardsContainer");
  const summaries = computeUrlGroups(urlCards.map(urlGroupMemberSnapshot));
  for (const summary of summaries) {
    const groupEl = findUrlGroupElement(summary.recipeId) ?? buildUrlGroupElement(summary.recipeId);
    container.appendChild(groupEl);
    const rowsEl = requireChild<HTMLElement>(groupEl, ".url-group-rows");
    if (urlGroupExpandedByRecipeId.get(summary.recipeId)) rowsEl.classList.remove("hidden");
    groupEl.classList.toggle("expanded", urlGroupExpandedByRecipeId.get(summary.recipeId) ?? false);
  }
  for (const card of urlCards) {
    const recipeId = recipeIdForUrl(card.dom.input.value.trim());
    const rowEl = card.dom.containerElement;
    const targetParent =
      recipeId === null
        ? container
        : (findUrlGroupElement(recipeId)?.querySelector<HTMLElement>(".url-group-rows") ??
          container);
    if (rowEl.parentElement !== targetParent) targetParent.appendChild(rowEl);
  }
  for (const groupEl of [...container.querySelectorAll<HTMLElement>(".url-group")]) {
    if (requireChild<HTMLElement>(groupEl, ".url-group-rows").children.length === 0)
      groupEl.remove();
  }
  updateUrlGroupHeaders();
}

function updateUrlGroupHeaders(): void {
  for (const summary of computeUrlGroups(urlCards.map(urlGroupMemberSnapshot))) {
    const groupEl = findUrlGroupElement(summary.recipeId);
    if (!groupEl) continue;
    const view = groupHeaderView(summary);
    const statusEl = requireChild<HTMLElement>(groupEl, ".url-group-status");
    statusEl.innerHTML =
      (view.showSpinner ? '<span class="spinner"></span>' : "") +
      `<span>${esc(view.primaryText)}</span>`;
    requireChild<HTMLElement>(groupEl, ".url-group-cancel").classList.toggle(
      "hidden",
      !view.showCancel,
    );
  }
}

function expandUrlGroup(recipeId: RecipeId): void {
  if (urlGroupExpandedByRecipeId.get(recipeId)) return;
  urlGroupExpandedByRecipeId.set(recipeId, true);
  const groupEl = findUrlGroupElement(recipeId);
  if (!groupEl) return;
  groupEl.classList.add("expanded");
  expandElement(requireChild<HTMLElement>(groupEl, ".url-group-rows"));
}

function toggleUrlGroup(recipeId: RecipeId): void {
  const groupEl = findUrlGroupElement(recipeId);
  if (!groupEl) return;
  const rowsEl = requireChild<HTMLElement>(groupEl, ".url-group-rows");
  const isExpanded = urlGroupExpandedByRecipeId.get(recipeId) ?? false;
  urlGroupExpandedByRecipeId.set(recipeId, !isExpanded);
  groupEl.classList.toggle("expanded", !isExpanded);
  if (isExpanded) collapseElementAsync(rowsEl);
  else expandElement(rowsEl);
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

function createUrlCard(): UrlCard {
  const cardEl = document.createElement("div");
  cardEl.className = "source-url-row";
  cardEl.innerHTML = `
    <div class="url-row">
      <a class="url-link hidden" target="_blank" rel="noopener noreferrer"></a>
      <input type="url" class="url-input" placeholder="Paste search URL…" />
      <button class="btn icon-btn url-remove-btn hidden" type="button" title="Remove">${X_ICON}</button>
    </div>
    <div class="url-card-status hidden"></div>
    <div class="url-criteria hidden"><div class="criteria-grid"></div><div class="cache-status hidden"></div></div>
  `;
  getElement("urlCardsContainer").appendChild(cardEl);

  const input = requireChild<HTMLInputElement>(cardEl, ".url-input");
  const linkElement = requireChild<HTMLAnchorElement>(cardEl, ".url-link");
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
    removeButton,
    criteriaElement,
    cacheStatusElement,
    statusElement,
  };
  const urlCard: UrlCard = { data, dom };
  urlCards.push(urlCard);
  urlCardData.push(data);

  input.addEventListener("input", () => handleUrlInputChanged(urlCard));
  input.addEventListener("keydown", (keyboardEvent: KeyboardEvent) => {
    if (keyboardEvent.key === "Enter" && canSearchCard(urlCard)) searchUrlCardAsync(urlCard);
  });
  removeButton.addEventListener("click", () => removeUrlCard(urlCard));

  updateRemoveButtons();
  syncUrlGroups();
  return urlCard;
}

function resetAllResults(): void {
  setIsAiFilterRunning(false);
  setAiFilterPendingRun(false);
  listingsByUrl.clear();
  getElement("listingsContainer").innerHTML = "";
  getElement("resultCount").textContent = "0";
  setShowFilteredListings(false);
  getElement<HTMLButtonElement>("toggleFilteredBtn").textContent = "show";
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
  getElement<HTMLButtonElement>("deepBtn").disabled =
    isDeepSearchRunning || isAnyCardSearching || !hasUnscraped;
  const prompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
  const hash = promptHash(prompt);
  const isFilterCurrent =
    !prompt ||
    listings.length === 0 ||
    listings.every((listingItem) => listingItem.aiCheckedHash === hash);
  const updateBtn = getElement<HTMLButtonElement>("applyAiFilterBtn");
  updateBtn.style.display = isFilterCurrent ? "none" : "";
  updateBtn.disabled = shouldDisableUpdateBtn({ isFilterCurrent, isAiFilterRunning });
  if (!isFilterCurrent) updateBtn.textContent = "Update filter";
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
  const cardIndex = urlCards.indexOf(card);
  if (cardIndex !== -1) {
    urlCards.splice(cardIndex, 1);
    urlCardData.splice(cardIndex, 1);
  }
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

function filterBannerText(item: ListingItem): string {
  return item.aiFilterReason ? `Filtered by AI: ${item.aiFilterReason}` : "Filtered";
}

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

function updateDiscoveryBtn(): void {
  const hasPrompt = !!getElement<HTMLTextAreaElement>("discoveryPrompt").value.trim();
  const hasValidPrice =
    parseMaxPrice(getElement<HTMLInputElement>("discoveryMaxPrice").value) !== undefined;
  const isPickupOnly = !getElement<HTMLInputElement>("discoveryAllowShipping").checked;
  const hasRegion = !isPickupOnly || !!getElement<HTMLSelectElement>("discoveryRegion").value;
  getElement<HTMLButtonElement>("discoveryBtn").disabled =
    !hasPrompt || !hasValidPrice || !hasRegion;
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
              item.aiFilterReason = result.pass ? null : (result.reason ?? "Filtered by AI");
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

// ── SSE streaming ─────────────────────────────────────────────────────────────

async function streamPostAsync(
  endpoint: string,
  body: unknown,
  onData: (data: Record<string, unknown>) => void,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = (await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }))) as { error?: string };
    throw new Error(errorBody.error ?? `HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");
  const textDecoder = new TextDecoder();
  let streamBuffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    streamBuffer += textDecoder.decode(value, { stream: true });
    const lines = streamBuffer.split("\n");
    streamBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          onData(JSON.parse(line.slice(6)));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ── Card helpers ──────────────────────────────────────────────────────────────

// Looks up a listing card by URL. Returns null if not yet rendered.
function getCardByUrl(url: string): HTMLElement | null {
  const id = cardIdByUrl.get(url);
  return id ? document.getElementById(id) : null;
}

function formatReserveText(status: string): string {
  if (status === "NONE") return "No reserve";
  if (status === "MET") return "Reserve met";
  if (status === "NOT_MET") return "Reserve not met";
  return "";
}

function cleanDescription(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPricesHtml(item: ListingItem): string {
  let html = `<span class="price">${esc(item.data.priceDisplay)}</span>`;
  if (item.detail && item.data.isAuction && item.detail.buyNowPrice != null) {
    html += `<span class="price-buynow">Buy Now: <strong>$${Number(item.detail.buyNowPrice).toLocaleString()}</strong></span>`;
  }
  return html;
}

function buildMetaHtml(item: ListingItem): string {
  const left = `<span class="meta-left"><span class="meta-text">${esc(item.data.location)}</span></span>`;
  let html = "";
  const detail = item.detail;
  if (detail && item.data.isAuction) {
    const reserve = formatReserveText(detail.reserveStatus);
    if (reserve)
      html += `<span class="badge badge-${detail.reserveStatus.toLowerCase().replace("_", "-")}">${esc(reserve)}</span>`;
  }
  return `${left}<span class="meta-right">${html}</span>`;
}

function buildExtrasHtml(detail: ListingDetail): string {
  let body = "";

  // ── Details ───────────────────────────────────────────────────────────────
  if (detail.details.length > 0) {
    body += `<div class="deep-section">
      <div class="deep-section-label">Details</div>
      <div class="details-table">${detail.details
        .map(
          ({ key, value }) =>
            `<span class="details-key">${esc(key)}</span><span class="details-val">${esc(value)}</span>`,
        )
        .join("")}</div>
    </div>`;
  }

  // ── Description ───────────────────────────────────────────────────────────
  body += `<div class="deep-section"><div class="deep-section-label">Description</div>`;
  if (detail.description) {
    body += `<div class="listing-description">${esc(cleanDescription(detail.description))}</div>`;
  } else {
    body += `<p class="deep-empty">No description provided.</p>`;
  }
  body += `</div>`;

  // ── Questions & Answers ───────────────────────────────────────────────────
  if (detail.questionsAndAnswers.length > 0) {
    body += `<div class="deep-section"><div class="deep-section-label">Questions &amp; Answers</div>`;
    body += detail.questionsAndAnswers
      .map(
        ({ question, answer }) =>
          `<div class="qa-pair">` +
          `<div class="qa-item"><span class="qa-badge qa-q">Q</span><span class="qa-text">${esc(question)}</span></div>` +
          (answer
            ? `<div class="qa-item"><span class="qa-badge qa-a">A</span><span class="qa-text">${esc(answer)}</span></div>`
            : "") +
          `</div>`,
      )
      .join("");
    body += `</div>`;
  }

  return `<div class="extras-body collapsed">${body}<div class="extras-fade"></div></div><button class="extras-toggle" style="display:none">Show less</button>`;
}

function renderCard(item: ListingItem): void {
  const listing = item.data;

  // Assign a UUID-based id on first render; reuse it on re-renders (e.g. after deep search enrichment).
  let cardId = cardIdByUrl.get(listing.url);
  if (!cardId) {
    cardId = `card-${crypto.randomUUID()}`;
    cardIdByUrl.set(listing.url, cardId);
  }

  const existing = document.getElementById(cardId);
  const card = existing ?? document.createElement("div");
  card.className = `listing-card${item.detail ? " enriched" : ""}`;
  card.id = cardId;
  card.dataset.url = listing.url;

  const thumb = listing.thumbnailUrl
    ? `<img class="listing-thumb" src="${esc(listing.thumbnailUrl)}" alt="" loading="lazy">`
    : `<div class="listing-thumb-placeholder">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
       </div>`;

  card.innerHTML = `
    <div class="filter-banner hidden"></div>
    <div class="listing-card-content">
      <div class="listing-thumb-wrap">
        ${thumb}
        <span class="listing-source-badge">${sourceFaviconHtml(listing.source)}</span>
      </div>
      <div class="listing-body">
        <div class="listing-meta">
          ${buildMetaHtml(item)}
        </div>
        <div class="listing-title">
          <a href="${esc(listing.url)}" target="_blank" rel="noopener" title="${esc(listing.title)}">${esc(listing.title)}</a>
        </div>
        <div class="listing-extras">${item.detail ? buildExtrasHtml(item.detail) : ""}</div>
        <div class="listing-prices">
          ${buildPricesHtml(item)}
        </div>
      </div>
    </div>
  `;

  if (!existing) getElement("listingsContainer").appendChild(card);
}

function toggleDescription(btn: HTMLButtonElement): void {
  const desc = btn.closest(".listing-description");
  if (!desc) throw new Error("toggleDescription: missing .listing-description ancestor");
  const full = requireChild<HTMLElement>(desc, ".desc-full");
  const short = requireChild<HTMLElement>(desc, ".desc-short");
  const expanded = full.classList.contains("open");
  full.classList.toggle("open", !expanded);
  short.classList.toggle("hidden", !expanded);
  btn.textContent = expanded ? "Show more" : "Show less";
}

// ── Search ────────────────────────────────────────────────────────────────────

// ── Deep Search ───────────────────────────────────────────────────────────────

async function runDeepSearchAsync(): Promise<void> {
  const toScrape = getOrderedListings()
    .filter((item) => !item.hasBeenDeepSearched && item.aiFilterReason === null)
    .map((item) => item.data);

  if (toScrape.length === 0) return;

  setDeepSearchId(crypto.randomUUID());
  setDeepSearchCancellationRequested(false);
  setDeepSearchBusy(true);
  let detailsReceived = 0;

  for (const listing of toScrape) {
    const card = getCardByUrl(listing.url);
    if (card) {
      requireChild<HTMLElement>(card, ".listing-extras").innerHTML =
        '<div style="padding-top:0.6rem">' +
        '<div class="skeleton" style="width:70%;margin-bottom:0.4rem"></div>' +
        '<div class="skeleton" style="width:40%"></div></div>';
    }
  }

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
        const detail = ev.detail as ListingDetail;
        const item = listingsByUrl.get(ev.url as string);
        if (item) {
          item.hasBeenDeepSearched = true;
          item.detail = detail;
          item.aiCheckedHash = null;
          renderCard(item);
        }

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

  // Clear skeleton loaders from listings that never received details
  for (const listing of toScrape) {
    const item = listingsByUrl.get(listing.url);
    if (item && !item.hasBeenDeepSearched) {
      const card = getCardByUrl(listing.url);
      if (card) requireChild<HTMLElement>(card, ".listing-extras").innerHTML = "";
    }
  }

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
  if (search.urls.length === 0) return;
  urlCards[0].dom.input.value = search.urls[0];
  for (let urlIndex = 1; urlIndex < search.urls.length; urlIndex++) {
    createUrlCard().dom.input.value = search.urls[urlIndex];
  }
  for (const card of urlCards) handleUrlInputChanged(card);
  applyDiscoverInputs(search.discoverInputs);
  getElement<HTMLTextAreaElement>("aiFilter").value = search.aiFilter ?? "";
  setSearchName(search.name);
  activateSidebarTab(document, "search");
  // loadSavedSearchAsync owns the dispatch: kick off a search for every configured card.
  fireAllCardSearches(urlCards, searchUrlCardAsync);
}

// ── Event listeners ───────────────────────────────────────────────────────────

function initApp(): void {
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
    getElement<HTMLButtonElement>("toggleFilteredBtn").textContent = showFilteredListings
      ? "hide"
      : "show";
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
    discoveryButton.textContent = "Working…";
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
      discoveryButton.textContent = "Go sifting";
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

  // Event delegation for description toggles (avoids global onclick)
  getElement("listingsContainer").addEventListener("click", (mouseEvent: MouseEvent) => {
    const showLessBtn = (mouseEvent.target as HTMLElement).closest<HTMLButtonElement>(
      ".extras-toggle",
    );
    if (showLessBtn) {
      collapseExtras(showLessBtn);
      return;
    }
    const collapsedBody = (mouseEvent.target as HTMLElement).closest<HTMLElement>(
      ".extras-body.collapsed",
    );
    if (collapsedBody) {
      expandExtras(collapsedBody);
      return;
    }
    const descBtn = (mouseEvent.target as HTMLElement).closest<HTMLButtonElement>(".desc-toggle");
    if (descBtn) toggleDescription(descBtn);
  });

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
