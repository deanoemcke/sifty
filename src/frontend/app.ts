import type { Listing, ListingDetail } from "../lib/recipes/base";
import { isValidRecipeUrl } from "../lib/recipes/matcher";
import { getElement, requireChild } from "./domUtils";
import { esc } from "./html";
import { sourceFaviconHtml } from "./recipeDisplay";
import {
  canCancelSearch,
  cardIdByUrl,
  currentSearchName,
  deepSearchCancellationRequested,
  deepSearchId,
  type DiscoverInputs,
  isCardSearchActive,
  isDeepSearchRunning,
  isSearchButtonDisabled,
  type ListingItem,
  listingsByUrl,
  type SavedSearch,
  setCurrentSearchName,
  setDeepSearchCancellationRequested,
  setDeepSearchId,
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
  searchButton: HTMLButtonElement;
  removeButton: HTMLButtonElement;
  criteriaElement: HTMLElement;
  countElement: HTMLElement;
  cacheStatusElement: HTMLElement;
  statusElement: HTMLElement;
}

type UrlCard = { data: UrlCardData; dom: UrlCardDom };
const urlCards: UrlCard[] = [];

// ── Utility ───────────────────────────────────────────────────────────────────

function promptHash(inputString: string): number {
  let h = 5381;
  for (let charIndex = 0; charIndex < inputString.length; charIndex++)
    h = ((h * 33) ^ inputString.charCodeAt(charIndex)) >>> 0;
  return h;
}

function readDiscoverInputs(): DiscoverInputs {
  const maxPriceRaw = getElement<HTMLInputElement>("discoveryMaxPrice").value;
  return {
    prompt: getElement<HTMLTextAreaElement>("discoveryPrompt").value.trim(),
    maxPrice: maxPriceRaw ? parseFloat(maxPriceRaw) : undefined,
    fulfillment: getElement<HTMLSelectElement>("discoveryFulfillment").value,
    region: getElement<HTMLSelectElement>("discoveryRegion").value || undefined,
  };
}

function applyDiscoverInputs(inputs: DiscoverInputs | undefined): void {
  if (!inputs) return;
  getElement<HTMLTextAreaElement>("discoveryPrompt").value = inputs.prompt ?? "";
  getElement<HTMLInputElement>("discoveryMaxPrice").value =
    inputs.maxPrice != null ? String(inputs.maxPrice) : "";
  getElement<HTMLSelectElement>("discoveryFulfillment").value = inputs.fulfillment ?? "any";
  const isPickup = inputs.fulfillment === "pickup";
  getElement("discoveryRegion").style.display = isPickup ? "" : "none";
  if (inputs.region) getElement<HTMLSelectElement>("discoveryRegion").value = inputs.region;
  updateDiscoveryBtn();
}

function setCardStatus(
  card: UrlCard,
  statusMessage: string | null,
  type: "info" | "success" | "error" = "info",
): void {
  const statusBar = card.dom.statusElement;
  if (!statusMessage) {
    statusBar.classList.add("hidden");
    return;
  }
  statusBar.className = `url-card-status ${type}`;
  statusBar.innerHTML =
    type === "info"
      ? `<span class="spinner"></span><span>${esc(statusMessage)}</span>`
      : `<span>${esc(statusMessage)}</span>`;
  statusBar.classList.remove("hidden");
}

function setSearchingStatus(card: UrlCard, statusMessage: string): void {
  const statusBar = card.dom.statusElement;
  statusBar.className = "url-card-status info";
  statusBar.innerHTML = `<span class="spinner"></span><span>${esc(statusMessage)}</span>`;
  if (canCancelSearch(card.data.searchStatus)) {
    const cancelButton = document.createElement("button");
    cancelButton.className = "cache-clear-btn";
    cancelButton.style.marginLeft = "0.5rem";
    cancelButton.textContent = "cancel";
    cancelButton.addEventListener("click", () => cancelSearch(card));
    statusBar.appendChild(cancelButton);
  }
  statusBar.classList.remove("hidden");
}

function cancelSearch(card: UrlCard): void {
  if (!canCancelSearch(card.data.searchStatus)) return;
  card.data.searchStatus = "cancelling";
  setSearchingStatus(card, "Cancelling…");
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

function updateCardSearchBtn(card: UrlCard): void {
  const current = card.dom.input.value.trim();
  card.dom.searchButton.disabled =
    isDeepSearchRunning ||
    !isValidRecipeUrl(current) ||
    isSearchButtonDisabled(card.data.searchStatus, card.data.searchedUrl, current);
}

function setDeepSearchBusy(busy: boolean): void {
  setIsDeepSearchRunning(busy);
  for (const card of urlCards) updateCardSearchBtn(card);
  renderDerived();
}

const SEARCH_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

function createUrlCard(): UrlCard {
  const idx = urlCards.length;
  const cardEl = document.createElement("div");
  cardEl.className = "card url-card";
  cardEl.innerHTML = `
    <div class="card-label" style="display:flex;align-items:center">URL ${idx + 1}<span class="url-card-count"></span><button class="btn btn-ghost url-remove-btn hidden" style="margin-left:auto;padding:0.15rem 0.45rem;line-height:1" title="Remove">✕</button></div>
    <div class="url-row">
      <input type="url" class="url-input" placeholder="Paste search URL…" />
      <button class="btn btn-primary url-search-btn" disabled>${SEARCH_ICON} Search</button>
    </div>
    <div class="url-card-status hidden"></div>
    <div class="url-criteria hidden"><div class="criteria-grid"></div><div class="cache-status hidden"></div></div>
  `;
  getElement("urlCardsContainer").appendChild(cardEl);

  const input = requireChild<HTMLInputElement>(cardEl, ".url-input");
  const searchButton = requireChild<HTMLButtonElement>(cardEl, ".url-search-btn");
  const removeButton = requireChild<HTMLButtonElement>(cardEl, ".url-remove-btn");
  const criteriaElement = requireChild<HTMLElement>(cardEl, ".url-criteria");
  const countElement = requireChild<HTMLElement>(cardEl, ".url-card-count");
  const cacheStatusElement = requireChild<HTMLElement>(cardEl, ".cache-status");
  const statusElement = requireChild<HTMLElement>(cardEl, ".url-card-status");

  const data: UrlCardData = {
    searchStatus: "idle",
    searchedUrl: "",
    searchId: null,
    listingUrls: [],
  };
  const dom: UrlCardDom = {
    containerElement: cardEl,
    input,
    searchButton,
    removeButton,
    criteriaElement,
    countElement,
    cacheStatusElement,
    statusElement,
  };
  const urlCard: UrlCard = { data, dom };
  urlCards.push(urlCard);
  urlCardData.push(data);

  input.addEventListener("input", () => updateCardSearchBtn(urlCard));
  input.addEventListener("keydown", (keyboardEvent: KeyboardEvent) => {
    if (keyboardEvent.key === "Enter" && !searchButton.disabled) searchUrlCardAsync(urlCard);
  });
  searchButton.addEventListener("click", () => searchUrlCardAsync(urlCard));
  removeButton.addEventListener("click", () => removeUrlCard(urlCard));

  updateRemoveButtons();
  return urlCard;
}

function resetAllResults(): void {
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
    card.dom.countElement.textContent = "";
    requireChild<HTMLElement>(card.dom.criteriaElement, ".criteria-grid").innerHTML = "";
    card.dom.criteriaElement.classList.add("hidden");
    card.dom.cacheStatusElement.classList.add("hidden");
    card.dom.cacheStatusElement.innerHTML = "";
    card.dom.statusElement.classList.add("hidden");
    card.data.searchId = null;
    card.dom.input.readOnly = false;
    updateCardSearchBtn(card);
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
  const visible = listings.filter(
    (listingItem) => listingItem.aiFilterReason === null,
  );
  const filtered = listings.length - visible.length;
  getElement("resultCount").textContent = String(visible.length);
  getElement("filteredCountNum").textContent = String(filtered);
  getElement("filteredCount").classList.toggle("hidden", filtered === 0);
  const isAnyCardSearching = urlCards.some((card) =>
    isCardSearchActive(card.data.searchStatus),
  );
  const hasUnscraped = visible.some((listingItem) => !listingItem.hasBeenDeepSearched);
  getElement<HTMLButtonElement>("deepBtn").disabled =
    isDeepSearchRunning || isAnyCardSearching || !hasUnscraped;
  const prompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
  const hash = promptHash(prompt);
  getElement<HTMLButtonElement>("applyAiFilterBtn").disabled =
    !prompt ||
    listings.length === 0 ||
    listings.every((listingItem) => listingItem.aiCheckedHash === hash);
}

function updateRemoveButtons(): void {
  const show = urlCards.length > 1;
  for (const card of urlCards) card.dom.removeButton.classList.toggle("hidden", !show);
}

function resetCardForResearch(card: UrlCard): void {
  const otherUrls = new Set(
    urlCards.flatMap((c) => (c === card ? [] : c.data.listingUrls)),
  );
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
  card.dom.countElement.textContent = "";
  requireChild<HTMLElement>(card.dom.criteriaElement, ".criteria-grid").innerHTML = "";
  card.dom.criteriaElement.classList.add("hidden");
  card.dom.cacheStatusElement.classList.add("hidden");
  card.dom.cacheStatusElement.innerHTML = "";
  card.dom.statusElement.classList.add("hidden");
  card.dom.input.readOnly = false;
  if (getOrderedListings().length === 0) getElement("resultsSection").classList.add("hidden");
  renderDerived();
}

function removeUrlCard(card: UrlCard): void {
  const otherUrls = new Set(
    urlCards.flatMap((c) => (c === card ? [] : c.data.listingUrls)),
  );
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
  applyClientFilters();
}

async function searchUrlCardAsync(card: UrlCard): Promise<void> {
  const url = card.dom.input.value.trim();
  if (!isValidRecipeUrl(url)) return;

  if (card.data.searchStatus === "done") resetCardForResearch(card);

  getElement("resultsSection").classList.remove("hidden");
  card.data.searchStatus = "searching";
  card.data.searchId = crypto.randomUUID();
  updateCardSearchBtn(card);
  renderDerived();
  setSearchingStatus(card, "Fetching listings…");

  let totalFound = 0;
  let cachedAge = "";
  let searchError = false;
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
        if (canCancelSearch(card.data.searchStatus)) setSearchingStatus(card, ev.message as string);
      } else if (ev.type === "listing") {
        const listing = ev.data as Listing;
        totalFound++;
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
        }
      } else if (ev.type === "error") {
        searchError = true;
        setCardStatus(card, ev.message as string, "error");
      }
    });
  } catch (error) {
    searchError = true;
    setCardStatus(card, (error as Error).message, "error");
  }

  const wasCancelled = (card.data.searchStatus as UrlCardSearchStatus) === "cancelling";
  card.data.searchStatus = wasCancelled ? "idle" : "done";
  card.data.searchId = null;

  if (wasCancelled) {
    setCardStatus(
      card,
      `Cancelled — ${totalFound} listing${totalFound !== 1 ? "s" : ""} loaded`,
      "error",
    );
    updateCardSearchBtn(card);
    if (listingsByUrl.size > 0) applyClientFilters();
    return;
  }
  card.data.searchedUrl = url;
  card.dom.input.readOnly = true;
  updateCardSearchBtn(card);

  if (cachedAge) {
    card.dom.cacheStatusElement.innerHTML = `Loaded from cache — ${esc(cachedAge)} <button class="cache-clear-btn">Clear</button>`;
    card.dom.cacheStatusElement.classList.remove("hidden");
    requireChild<HTMLButtonElement>(card.dom.cacheStatusElement, ".cache-clear-btn").addEventListener(
      "click",
      clearQuickSearchCacheAsync,
    );
  }
  card.dom.countElement.textContent = `— ${totalFound} listing${totalFound !== 1 ? "s" : ""}`;

  if (!searchError) {
    setCardStatus(card, `${totalFound} listing${totalFound !== 1 ? "s" : ""} found`, "success");
  }
  if (listingsByUrl.size > 0) {
    applyClientFilters();
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
  const maxPriceRaw = getElement<HTMLInputElement>("discoveryMaxPrice").value.trim();
  const maxPrice = parseFloat(maxPriceRaw);
  const hasValidPrice = maxPriceRaw !== "" && Number.isFinite(maxPrice) && maxPrice > 0;
  const isPickupOnly = getElement<HTMLSelectElement>("discoveryFulfillment").value === "pickup";
  const hasRegion = !isPickupOnly || !!getElement<HTMLSelectElement>("discoveryRegion").value;
  getElement<HTMLButtonElement>("discoveryBtn").disabled =
    !hasPrompt || !hasValidPrice || !hasRegion;
}

async function runAiFilterAsync(): Promise<void> {
  const prompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
  if (!prompt) return;
  const hash = promptHash(prompt);
  const toCheck = getOrderedListings().filter(
    (item) => item.aiCheckedHash !== hash,
  );
  if (toCheck.length === 0) return;

  const applyButton = getElement<HTMLButtonElement>("applyAiFilterBtn");
  applyButton.disabled = true;
  let checked = 0;
  applyButton.textContent = `Filtering 0/${toCheck.length}…`;

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
          applyButton.textContent = `Filtering ${checked}/${toCheck.length}…`;
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
    applyButton.textContent = "Apply AI Filter";
    renderDerived();
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

function renderShippingBadgeHtml(fulfillment: Listing["fulfillment"]): string {
  if (!fulfillment) return "";
  if (fulfillment.pickupAvailable && fulfillment.shippingAvailable)
    return '<span class="badge badge-both">Allows pickups</span>';
  if (fulfillment.pickupAvailable) return '<span class="badge badge-pickuponly">Pickup only</span>';
  return "";
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
  let html = sourceFaviconHtml(item.data.source);
  html += `<span class="meta-text">📍 ${esc(item.data.location)}</span>`;
  const detail = item.detail;
  if (detail) {
    const { shippingAvailable, pickupAvailable } = detail;
    const hasDefiniteData = shippingAvailable !== null || pickupAvailable !== null;
    if (item.data.isAuction) {
      const reserve = formatReserveText(detail.reserveStatus);
      if (reserve)
        html += `<span class="badge badge-${detail.reserveStatus.toLowerCase().replace("_", "-")}">${esc(reserve)}</span>`;
    }
    if (hasDefiniteData) {
      if (shippingAvailable && pickupAvailable) {
        html += '<span class="badge badge-both">Shipping &amp; pickup</span>';
      } else if (shippingAvailable) {
        html += '<span class="badge badge-shipping">Shipping only</span>';
      } else if (pickupAvailable) {
        html += '<span class="badge badge-pickuponly">Pickup only</span>';
      }
    } else {
      html += renderShippingBadgeHtml(item.data.fulfillment);
    }
  } else {
    html += renderShippingBadgeHtml(item.data.fulfillment);
  }
  return html;
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
      ${thumb}
      <div class="listing-body">
        <div class="listing-title">
          <a href="${esc(listing.url)}" target="_blank" rel="noopener">${esc(listing.title)}</a>
        </div>
        <div class="listing-prices">
          ${buildPricesHtml(item)}
        </div>
        <div class="listing-meta">
          ${buildMetaHtml(item)}
        </div>
        <div class="listing-extras">${item.detail ? buildExtrasHtml(item.detail) : ""}</div>
      </div>
    </div>
  `;

  if (!existing) getElement("listingsContainer").appendChild(card);
}

function expandExtras(body: HTMLElement): void {
  body.classList.remove("collapsed");
  const btn = body.nextElementSibling as HTMLElement;
  if (btn) btn.style.display = "";
}

function collapseExtras(btn: HTMLButtonElement): void {
  const body = btn.previousElementSibling as HTMLElement;
  body.classList.add("collapsed");
  btn.style.display = "none";
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
}

function markDirty(): void {
  getElement("saveCurrentBtn").classList.remove("hidden");
}

function setSearchName(name: string | null): void {
  setCurrentSearchName(name);
  getElement("searchTitle").textContent = name ?? "new shiny thing";
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
    list.innerHTML = '<p class="deep-empty">No saved searches yet.</p>';
    return;
  }
  list.innerHTML = searches
    .map(
      (savedSearch) => `
    <div class="saved-search-row" data-id="${esc(savedSearch.id)}">
      <a class="saved-search-name load-saved-btn" href="#" title="${esc(savedSearch.name)}">${esc(savedSearch.name)}</a>
      <span class="saved-search-date">${new Date(savedSearch.createdAt).toLocaleDateString()} ${new Date(savedSearch.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}</span>
      <button class="btn btn-ghost delete-saved-btn" style="padding:0.25rem 0.65rem;font-size:0.78rem">✕</button>
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

function loadDiscoveryResults(data: { urls: string[]; name: string }, aiPrompt: string): void {
  resetAllResults();
  while (urlCards.length > 1) removeUrlCard(urlCards[urlCards.length - 1]);
  urlCards[0].dom.input.value = data.urls[0];
  updateCardSearchBtn(urlCards[0]);
  for (let urlIndex = 1; urlIndex < data.urls.length; urlIndex++) {
    const card = createUrlCard();
    card.dom.input.value = data.urls[urlIndex];
    updateCardSearchBtn(card);
  }
  setSearchName(data.name);
  markDirty();
  getElement<HTMLTextAreaElement>("aiFilter").value = aiPrompt;
}

async function loadSavedSearchAsync(search: SavedSearch): Promise<void> {
  resetAllResults();
  while (urlCards.length > 1) removeUrlCard(urlCards[urlCards.length - 1]);
  if (search.urls.length === 0) return;
  urlCards[0].dom.input.value = search.urls[0];
  updateCardSearchBtn(urlCards[0]);
  for (let urlIndex = 1; urlIndex < search.urls.length; urlIndex++) {
    const card = createUrlCard();
    card.dom.input.value = search.urls[urlIndex];
    updateCardSearchBtn(card);
  }
  applyDiscoverInputs(search.discoverInputs);
  getElement<HTMLTextAreaElement>("aiFilter").value = search.aiFilter ?? "";
  setSearchName(search.name);
  getElement("savedSearchesPanel").classList.add("hidden");
  for (const card of urlCards) searchUrlCardAsync(card);
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

  // Populate region dropdown and wire fulfillment toggle
  fetch("/api/regions")
    .then((regionResponse) => regionResponse.json())
    .then((regions: Array<{ value: string; display: string }>) => {
      const select = getElement<HTMLSelectElement>("discoveryRegion");
      for (const region of regions) {
        const opt = document.createElement("option");
        opt.value = region.value;
        opt.textContent = region.display;
        select.appendChild(opt);
      }
    })
    .catch(() => {
      /* regions unavailable — dropdown stays empty */
    });

  getElement<HTMLSelectElement>("discoveryFulfillment").addEventListener("change", () => {
    const isPickup = getElement<HTMLSelectElement>("discoveryFulfillment").value === "pickup";
    getElement("discoveryRegion").style.display = isPickup ? "" : "none";
    updateDiscoveryBtn();
  });
  getElement<HTMLSelectElement>("discoveryRegion").addEventListener("change", updateDiscoveryBtn);

  getElement<HTMLTextAreaElement>("discoveryPrompt").addEventListener("input", updateDiscoveryBtn);
  getElement<HTMLInputElement>("discoveryMaxPrice").addEventListener("input", updateDiscoveryBtn);
  getElement<HTMLButtonElement>("discoveryBtn").addEventListener("click", async () => {
    const prompt = getElement<HTMLTextAreaElement>("discoveryPrompt").value.trim();
    if (!prompt) return;
    const maxPriceVal = getElement<HTMLInputElement>("discoveryMaxPrice").value.trim();
    const maxPrice = maxPriceVal ? parseFloat(maxPriceVal) : undefined;
    const fulfillment = getElement<HTMLSelectElement>("discoveryFulfillment").value;
    const regionValue =
      fulfillment === "pickup" ? getElement<HTMLSelectElement>("discoveryRegion").value : undefined;
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
      discoveryButton.textContent = "Get it!";
      updateDiscoveryBtn();
    }
  });

  getElement<HTMLTextAreaElement>("aiFilter").addEventListener("input", renderDerived);
  getElement<HTMLTextAreaElement>("aiFilter").addEventListener("input", markDirty);
  getElement<HTMLButtonElement>("applyAiFilterBtn").addEventListener("click", () =>
    runAiFilterAsync(),
  );

  // Mark dirty on any URL input change or new URL card
  getElement("urlCardsContainer").addEventListener("input", markDirty);
  getElement("addUrlBtn").addEventListener("click", markDirty);

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

  // ── Saved searches UI ─────────────────────────────────────────────────────────

  getElement("savedSearchesToggle").addEventListener("click", () => {
    const panel = getElement("savedSearchesPanel");
    const nowHidden = panel.classList.toggle("hidden");
    if (!nowHidden) fetchSavedSearchesAsync();
  });

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
    getElement("savedSearchesPanel").classList.remove("hidden");
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
