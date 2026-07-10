// ── Results grid rendering ────────────────────────────────────────────────────
// Renders listing cards and everything derived from the result set: counts,
// the filtered show/hide toggle, deep-search button visibility, and the
// client-side AI-filter pass over the rendered cards.

import { requirePattern } from '../lib/recipes/metadata';
import { getElement, requireChild } from './domUtils';
import { esc } from './html';
import { applyListingCardAccessibility } from './listingCardActivation';
import { buildCardFooterHtml, buildExternalLinkButtonHtml, filterBannerText } from './listingHtml';
import { rafSchedule } from './rafSchedule';
import { sourceBadgeHtml } from './recipeDisplay';
import { DEFAULT_SORT_OPTION, sortListings } from './sortListings';
import {
  cardIdByUrl,
  isAiFilterRunning,
  isCardSearchActive,
  isDeepSearchRunning,
  type ListingItem,
  listingsByUrl,
  showFilteredListings,
  sortBy,
  urlCardDataById,
} from './state';
import { updateUrlGroupHeaders } from './urlGroupsView';

// Sole writer of the filtered-results toggle button state — derives it from state.
export function renderFilteredToggle(): void {
  const toggleBtn = getElement<HTMLButtonElement>('toggleFilteredBtn');
  const label = showFilteredListings ? 'Hide filtered listings' : 'Show filtered listings';
  toggleBtn.setAttribute('aria-pressed', String(showFilteredListings));
  toggleBtn.title = label;
  toggleBtn.setAttribute('aria-label', label);
}

export function getOrderedListings(): ListingItem[] {
  const seen = new Set<string>();
  return [...urlCardDataById.values()]
    .flatMap((data) =>
      data.listingUrls.filter((listingUrl) => !seen.has(listingUrl) && seen.add(listingUrl))
    )
    .flatMap((listingUrl) => {
      // Every URL in listingUrls was added to listingsByUrl at the same time in searchUrlCardAsync.
      const listing = listingsByUrl.get(listingUrl);
      return listing ? [listing] : [];
    });
}

export function getSortedListings(): ListingItem[] {
  return sortListings(getOrderedListings(), sortBy);
}

// Reorders rendered cards by moving DOM nodes (container.appendChild) so
// DOM/tab order always matches visual order for keyboard and screen-reader
// users. appendChild-ing an already-attached node moves it without detaching
// focus in modern browsers, so re-sorting a focused card doesn't steal focus
// away from it. It may still shift the scroll position of the moved card —
// that's a known, currently-unaddressed trade-off, not fixed here.
//
// Takes the caller's already-computed listing list rather than recomputing it
// via getSortedListings()/getOrderedListings() — renderDerived() already
// built that list for its own counts, so recomputing it here would redo the
// same urlCardDataById/listingsByUrl traversal. renderDerived() never calls
// this directly — see scheduleSortOrderUpdate() below, which coalesces the
// many calls renderDerived makes during an active SSE stream into one call
// here per animation frame.

// O(n) scan (no sort, no requirePattern-per-comparison) for whether listings
// span more than one canonical source group — e.g. trademe mixed with
// facebook. trademe and trademe-expired share a groupId (see
// RECIPE_PATTERNS in metadata.ts) so a trademe/trademe-expired mix does NOT
// count as mixed here, matching sortListings' own grouping.
function sourcesAreMixed(listings: ListingItem[]): boolean {
  if (listings.length === 0) return false;
  const firstGroupId = requirePattern(listings[0].data.source).groupId;
  return listings.some((item) => requirePattern(item.data.source).groupId !== firstGroupId);
}

// Returns the sorted listings when re-sorting would actually reorder the
// DOM, or null when it wouldn't. Shared by scheduleSortOrderUpdate (to
// decide whether to schedule a frame at all) and applySortOrder (to decide
// whether to touch the DOM), so a single call through either function never
// sorts more than once.
//
// For the default source-url sort with sources that aren't mixed, insertion
// order is already correct by construction (see getOrderedListings), so this
// bypasses sorting entirely via the cheap sourcesAreMixed() scan above —
// restoring the O(1)/O(n) per-event cost this module's SSE-streaming
// comments below rely on for the common case. Only a mixed-source result set
// or a non-default sort falls through to an actual sort, and even then only
// once.
function sortedIfReorderNeeded(listings: ListingItem[]): ListingItem[] | null {
  if (sortBy === DEFAULT_SORT_OPTION && !sourcesAreMixed(listings)) return null;
  const sorted = sortListings(listings, sortBy);
  return sorted.every((item, index) => item === listings[index]) ? null : sorted;
}

export function applySortOrder(listings: ListingItem[]): void {
  const sorted = sortedIfReorderNeeded(listings);
  if (!sorted) return;
  const container = getElement('listingsContainer');
  sorted.forEach((item) => {
    const card = getCardByUrl(item.data.url);
    if (card) container.appendChild(card);
  });
}

// During an active SSE stream, renderDerived() (and therefore this) fires
// once per listing arrival — often many times within a single animation
// frame for a fast stream. Re-sorting and re-appending every card on every
// one of those calls is wasted work: only the sort that's in effect
// immediately before the next paint is ever visible. rafSchedule() coalesces
// a burst of calls into a single applySortOrder() invocation on the next
// frame, using whichever listings snapshot was passed most recently.
const scheduleApplySortOrderOnNextFrame = rafSchedule(applySortOrder);

export function scheduleSortOrderUpdate(listings: ListingItem[]): void {
  // Skip scheduling a frame at all for the common no-reorder case, rather
  // than scheduling one just to have applySortOrder no-op inside it.
  if (!sortedIfReorderNeeded(listings)) return;
  scheduleApplySortOrderOnNextFrame(listings);
}

export function renderDerived(): void {
  const listings = getOrderedListings();
  const passing = listings.filter((listingItem) => listingItem.aiFilterReason === null);
  const visibleCount = showFilteredListings ? listings.length : passing.length;
  getElement('resultCount').textContent = String(visibleCount);
  getElement('totalCount').textContent = String(listings.length);
  const isAnyCardSearching = [...urlCardDataById.values()].some((data) =>
    isCardSearchActive(data.searchStatus)
  );
  const hasUnscraped = passing.some((listingItem) => !listingItem.hasBeenDeepSearched);
  getElement('deepBtn').classList.toggle(
    'hidden',
    isDeepSearchRunning || isAnyCardSearching || !hasUnscraped
  );
  renderAiFilterStatus(listings);
  scheduleSortOrderUpdate(listings);
  updateUrlGroupHeaders();
}

// Sole writer of the ai-filter status line — shows a spinner while a run is
// in flight, otherwise the count of listings the filter has excluded.
export function renderAiFilterStatus(listings: ListingItem[]): void {
  const status = getElement('aiFilterStatus');
  if (isAiFilterRunning) {
    status.innerHTML = `<span class="spinner"></span><span>Filtering results...</span>`;
    return;
  }
  const excludedCount = listings.filter(
    (listingItem) => listingItem.aiFilterReason !== null
  ).length;
  status.textContent = `Filtered ${excludedCount} results`;
}

export function applyClientFilters(): void {
  for (const item of getOrderedListings()) {
    const passes = item.aiFilterReason === null;
    const card = getCardByUrl(item.data.url);
    if (card) {
      const banner = requireChild<HTMLElement>(card, '.filter-banner');
      if (passes) {
        card.style.display = '';
        card.classList.remove('filtered-out');
        banner.textContent = '';
        banner.classList.add('hidden');
      } else {
        card.classList.add('filtered-out');
        banner.textContent = filterBannerText(item);
        banner.classList.remove('hidden');
        card.style.display = showFilteredListings ? '' : 'none';
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
  const card = existing ?? document.createElement('div');
  card.className = listing.isSold ? 'listing-card sold' : 'listing-card';
  card.id = cardId;
  card.dataset.url = listing.url;

  const thumb = listing.thumbnailUrl
    ? `<img class="listing-thumb" src="${esc(listing.thumbnailUrl)}" alt="" loading="lazy">`
    : `<div class="listing-thumb-placeholder">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
       </div>`;

  // The card never re-renders once a deep search populates item.data's
  // extended fields — all detail-derived content (badges, buy-now price,
  // extras) lives in the modal only, so this template deliberately never
  // references those fields.
  // The image and title (inside .listing-open-area) open the modal.
  // The external-link button and the footer row (location/price) are both
  // rendered as siblings of .listing-open-area — never nested inside it —
  // so no focusable element sits inside the card's role="button" wrapper.
  // isExternalLinkTarget() (listingCardActivation.ts) still guards the
  // click/keydown paths so the link navigates instead of also opening the
  // modal, since it remains inside .listing-card.
  card.innerHTML = `
    <div class="listing-card-content">
      <div class="listing-open-area">
        <div class="listing-thumb-wrap">
          ${thumb}
          ${sourceBadgeHtml(listing.source, 28)}
          <div class="filter-banner hidden"></div>
          <div class="sold-banner ${listing.isSold ? '' : 'hidden'}">SOLD</div>
        </div>
        <div class="listing-body">
          <div class="listing-title" title="${esc(listing.title)}">${esc(listing.title)}</div>
        </div>
      </div>
      ${buildExternalLinkButtonHtml(listing.url)}
      <div class="listing-card-footer">
        ${buildCardFooterHtml(listing)}
      </div>
    </div>
  `;

  applyListingCardAccessibility(requireChild(card, '.listing-open-area'), listing.title);

  if (!existing) getElement('listingsContainer').appendChild(card);
}
