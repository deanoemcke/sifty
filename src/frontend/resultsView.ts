// ── Results grid rendering ────────────────────────────────────────────────────
// Renders listing cards and everything derived from the result set: counts,
// the filtered show/hide toggle, deep-search button visibility, and the
// client-side AI-filter pass over the rendered cards.

import { getElement, requireChild } from "./domUtils";
import { esc } from "./html";
import { applyListingCardAccessibility } from "./listingCardActivation";
import { buildCardMetaHtml, buildCardPriceHtml, filterBannerText } from "./listingHtml";
import { sourceBadgeHtml } from "./recipeDisplay";
import { promptHash, shouldDisableApplyFilterBtn } from "./renderUtils";
import {
  cardIdByUrl,
  isAiFilterRunning,
  isCardSearchActive,
  isDeepSearchRunning,
  type ListingItem,
  listingsByUrl,
  showFilteredListings,
  urlCardDataById,
} from "./state";
import { updateUrlGroupHeaders } from "./urlGroupsView";

// Sole writer of the filtered-results toggle label — derives it from state.
export function renderFilteredToggle(): void {
  getElement<HTMLButtonElement>("toggleFilteredBtn").textContent = showFilteredListings
    ? "hide"
    : "show";
}

export function getOrderedListings(): ListingItem[] {
  const seen = new Set<string>();
  return [...urlCardDataById.values()]
    .flatMap((data) =>
      data.listingUrls.filter((listingUrl) => !seen.has(listingUrl) && seen.add(listingUrl)),
    )
    .flatMap((listingUrl) => {
      // Every URL in listingUrls was added to listingsByUrl at the same time in searchUrlCardAsync.
      const listing = listingsByUrl.get(listingUrl);
      return listing ? [listing] : [];
    });
}

export function renderDerived(): void {
  const listings = getOrderedListings();
  const visible = listings.filter((listingItem) => listingItem.aiFilterReason === null);
  const filtered = listings.length - visible.length;
  getElement("resultCount").textContent = String(visible.length);
  getElement("filteredCountNum").textContent = String(filtered);
  getElement("filteredCount").classList.toggle("hidden", filtered === 0);
  const isAnyCardSearching = [...urlCardDataById.values()].some((data) =>
    isCardSearchActive(data.searchStatus),
  );
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

export function applyClientFilters(): void {
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

// Looks up a listing card by URL. Returns null if not yet rendered.
export function getCardByUrl(url: string): HTMLElement | null {
  const id = cardIdByUrl.get(url);
  return id ? document.getElementById(id) : null;
}

export function renderCard(item: ListingItem): void {
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

  // The card never re-renders once a deep search populates item.data's
  // extended fields — all detail-derived content (badges, buy-now price,
  // extras) lives in the modal only, so this template deliberately never
  // references those fields.
  card.innerHTML = `
    <div class="listing-card-content">
      <div class="listing-thumb-wrap">
        ${thumb}
        ${sourceBadgeHtml(listing.source, 28)}
        <div class="filter-banner hidden"></div>
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
  `;

  if (!existing) getElement("listingsContainer").appendChild(card);
}
