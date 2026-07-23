// ── Results grid rendering ────────────────────────────────────────────────────
// Renders listing cards and everything derived from the result set: counts,
// the filtered show/hide toggle, deep-search button visibility, and the
// client-side AI-filter pass over the rendered cards.

import { requirePattern } from '../lib/recipes/metadata';
import { getElement, requireChild } from './domUtils';
import { isMobileSheetActive } from './dropdownPanel';
import { esc } from './html';
import { applyListingCardAccessibility } from './listingCardActivation';
import { buildCardFooterHtml, buildExternalLinkButtonHtml, filterBannerText } from './listingHtml';
import { rafSchedule } from './rafSchedule';
import { sourceBadgeHtml } from './recipeDisplay';
import { djb2Hash } from './renderUtils';
import { renderShowOptions } from './showDropdown';
import { DEFAULT_SORT_OPTION, sortListings } from './sortListings';
import {
  cardIdByUrl,
  getListingCategory,
  isAiFilterRunning,
  isCardSearchActive,
  isDeepSearchRunning,
  type ListingItem,
  listingsByUrl,
  openModalListingUrl,
  sortBy,
  urlCardDataById,
  visibleListingCategories,
} from './state';
import { updateUrlGroupHeaders } from './urlGroupsView';

// Runs `fn`'s DOM mutation inside a View Transition so cards that pop in/out
// or change position (grid reflow) animate instead of snapping. Falls back
// to a plain synchronous call when the API isn't available (older browsers,
// and jsdom in tests) — no polyfill, the mutation still happens either way.
//
// Also falls back to a plain call while the listing modal is open: only
// cards opt out of the transition's implicit "root" capture (via
// view-transition-name on the card element), and the modal never sets one,
// so it gets swept into that root snapshot on every grid update. The browser
// paints that snapshot in the top layer, above the whole normal stacking
// context regardless of z-index, so an unrelated grid sweep could flash a
// stale frame of the modal over the live one. Skipping the transition while
// it's open removes the snapshot entirely rather than trying to out-rank it
// with stacking-context tricks. The Show/Sort/AI-filter dropdown panels have
// their own view-transition-name (styles.css) instead, so they don't need
// this treatment — each gets its own capture group and animates seamlessly.
function runWithViewTransition(fn: () => void): void {
  if (!document.startViewTransition || openModalListingUrl !== null) {
    fn();
    return;
  }
  // A transition started while another is still in flight (e.g. a fast SSE
  // burst calling this repeatedly) supersedes the prior one, whose promises
  // then reject with an AbortError. That's expected/harmless here — there's
  // nothing awaiting the result — but left unhandled it surfaces as an
  // uncaught console error on every skip, so swallow it explicitly.
  const transition = document.startViewTransition(fn);
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
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
  runWithViewTransition(() => {
    const container = getElement('listingsContainer');
    sorted.forEach((item) => {
      const card = getCardByUrl(item.data.url);
      if (card) container.appendChild(card);
    });
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
  renderShowOptions(listings);
  const isAnyCardSearching = [...urlCardDataById.values()].some((data) =>
    isCardSearchActive(data.searchStatus)
  );
  const hasUnscraped = passing.some((listingItem) => !listingItem.hasBeenDeepSearched);
  getElement('deepBtn').classList.toggle(
    'hidden',
    isDeepSearchRunning || isAnyCardSearching || !hasUnscraped
  );
  renderAiFilterButton(listings);
  scheduleSortOrderUpdate(listings);
  updateUrlGroupHeaders();
}

// On the mobile full-screen sheet, aiFilterBtn doubles as the sheet's sticky
// "apply and close" footer button (aiFilterDropdown.ts wires it as the
// dropdown's footer), so — matching the Show/Sort footer's live-count
// convention (setDropdownLabel in showDropdown.ts) — its label previews how
// many listings currently pass the AI filter instead of the bare "Filter" CTA
// that's all there's room for inline on desktop.
function aiFilterButtonLabel(listings: ListingItem[]): string {
  if (!isMobileSheetActive()) return isAiFilterRunning ? 'Filtering..' : 'Filter';
  const passingCount = listings.filter((item) => item.aiFilterReason === null).length;
  return `Filtering ${passingCount} / ${listings.length} results`;
}

// Sole writer of the ai-filter button's disabled/label state — disabled with
// a spinner while a run is in flight, otherwise enabled and ready to submit.
// With no criteria typed yet it's only *visually* disabled (aria-disabled,
// not the native attribute): on the mobile full-screen sheet this button
// doubles as the sheet's sole dismiss control (aiFilterDropdown.ts), and a
// natively disabled button never fires `click` in any browser — that would
// leave the sheet stuck open with no other way to close it. requestAiFilterRun
// already no-ops on a blank prompt (aiFilter.ts), so staying clickable here is
// safe. `listings` defaults to getOrderedListings() for the standalone
// 'input' listener wired in app.ts; renderDerived() passes its own
// already-computed list instead, so this doesn't recompute it a second time
// on every streamed listing.
export function renderAiFilterButton(listings: ListingItem[] = getOrderedListings()): void {
  const filterBtn = getElement<HTMLButtonElement>('aiFilterBtn');
  const promptIsEmpty = getElement<HTMLTextAreaElement>('aiFilter').value.trim() === '';
  filterBtn.disabled = isAiFilterRunning;
  if (promptIsEmpty) filterBtn.setAttribute('aria-disabled', 'true');
  else filterBtn.removeAttribute('aria-disabled');
  // The wrapper markup below (spinner + label span) is fully determined by
  // isAiFilterRunning, so skip recreating it when that hasn't changed:
  // renderDerived() fires once per streamed listing, and recreating the
  // spinner node on each call would restart its CSS animation mid-run.
  // data-state is a render cache key, not business state — isAiFilterRunning
  // in state.ts stays the source of truth. The label text itself is always
  // refreshed below, since the mobile pass/total count changes independently
  // of that running/idle state.
  const desiredButtonState = isAiFilterRunning ? 'running' : 'idle';
  if (filterBtn.dataset.state !== desiredButtonState) {
    filterBtn.dataset.state = desiredButtonState;
    filterBtn.innerHTML = isAiFilterRunning
      ? '<span class="spinner"></span><span class="ai-filter-btn-label"></span>'
      : '<span class="ai-filter-btn-label"></span>';
  }
  requireChild<HTMLElement>(filterBtn, '.ai-filter-btn-label').textContent =
    aiFilterButtonLabel(listings);
}

// "Pending" is derived straight from aiCheckedHash vs. the current prompt's
// hash, not from tracking which run's toCheck list a listing happened to be
// part of — quickSearch.ts triggers a separate runAiFilterAsync() call per
// URL card as its own search completes, so a saved search with multiple
// source URLs runs the AI filter several times over. A listing that streams
// in from a later URL card's search must still show as not-yet-checked even
// between runs, not just while the run that happened to cover it is in
// flight.
function currentAiFilterPromptHash(): number | null {
  const aiFilterPrompt = getElement<HTMLTextAreaElement>('aiFilter').value.trim();
  return aiFilterPrompt ? djb2Hash(aiFilterPrompt) : null;
}

function applyClientFiltersDom(aiFilterPromptHash: number | null): void {
  for (const item of getOrderedListings()) {
    const category = getListingCategory(item);
    const card = getCardByUrl(item.data.url);
    if (card) {
      const banner = requireChild<HTMLElement>(card, '.filter-banner');
      if (category !== 'filtered') {
        card.classList.remove('filtered-out');
        banner.textContent = '';
        banner.classList.add('hidden');
      } else {
        card.classList.add('filtered-out');
        banner.textContent = filterBannerText(item);
        banner.classList.remove('hidden');
      }
      card.style.display = visibleListingCategories.has(category) ? '' : 'none';
      card.classList.toggle(
        'ai-scanning',
        aiFilterPromptHash !== null && item.aiCheckedHash !== aiFilterPromptHash
      );
    }
  }
}

// Initial state for a card appended by renderCard() is the hidden 'entering'
// class (see below) — this strips it so there's something for the view
// transition to animate from.
function revealEnteringCards(): void {
  for (const card of document.querySelectorAll<HTMLElement>('.listing-card.entering')) {
    card.classList.remove('entering');
  }
}

// Card reveal (renderCard, below) and the client-filter sweep
// (applyClientFilters) both mutate the grid, and during an active SSE
// stream both can be triggered from the same 'listing' event handler
// (quickSearch.ts) within the same animation frame. Each used to run
// through its own independent rafSchedule instance, so both started their
// own document.startViewTransition — the second call aborts the first,
// flushing its mutation unanimated (cards "snap in" instead of fading).
// This shared pending-flags-plus-single-flush replaces that: whichever of
// the two mutations are due land inside one shared transition instead.
const pendingFrameMutations = {
  shouldRevealCards: false,
  shouldApplyClientFilters: false,
};

function flushFrameMutations(): void {
  const { shouldRevealCards, shouldApplyClientFilters } = pendingFrameMutations;
  if (!shouldRevealCards && !shouldApplyClientFilters) return;
  pendingFrameMutations.shouldRevealCards = false;
  pendingFrameMutations.shouldApplyClientFilters = false;

  const aiFilterPromptHash = shouldApplyClientFilters ? currentAiFilterPromptHash() : null;
  runWithViewTransition(() => {
    if (shouldRevealCards) revealEnteringCards();
    if (shouldApplyClientFilters) applyClientFiltersDom(aiFilterPromptHash);
  });
  if (shouldApplyClientFilters) renderDerived();
}

// A burst of same-frame calls (e.g. a fast SSE stream) coalesces into a
// single flush on the next frame, same pattern as scheduleSortOrderUpdate
// above — the difference here is the flush itself is shared between two
// call sites (see the comment on pendingFrameMutations) rather than
// dedicated to one.
const scheduleFrameMutationFlush = rafSchedule(flushFrameMutations);

export function applyClientFilters(): void {
  pendingFrameMutations.shouldApplyClientFilters = true;
  // Called directly (not scheduled): a single user action (e.g. the Show
  // dropdown checkbox) needs immediate feedback. This also absorbs a still-
  // pending scheduled reveal into the same transition, and clears both
  // flags — flushFrameMutations()'s already-scheduled frame then finds
  // nothing left to do and no-ops instead of starting an empty follow-up
  // transition.
  flushFrameMutations();
}

// During an active SSE stream — a 'listing' event in quickSearch.ts, or a
// 'result' batch in aiFilter.ts — events can fire many times within a single
// animation frame. applyClientFilters() walks every rendered card, so
// calling it directly from a hot streaming path is the same O(n)-per-event,
// O(n^2)-per-stream shape that scheduleSortOrderUpdate() above already
// solves for sorting. Streaming/multi-call sources should schedule; a single
// direct user action (e.g. the Show dropdown checkbox) should still call
// applyClientFilters() synchronously for immediate feedback.
export function scheduleClientFilterUpdate(): void {
  pendingFrameMutations.shouldApplyClientFilters = true;
  scheduleFrameMutationFlush();
}

function scheduleCardRevealOnNextFrame(): void {
  pendingFrameMutations.shouldRevealCards = true;
  scheduleFrameMutationFlush();
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
  // Stable per-card name so the View Transitions API (see
  // runWithViewTransition above) can track this card's identity across a
  // reflow and animate its position, instead of just cross-fading everything.
  card.style.viewTransitionName = cardId;

  const thumb = listing.thumbnailUrl
    ? `<img class="listing-thumb" src="${esc(listing.thumbnailUrl)}" alt="" loading="lazy">`
    : `<div class="listing-thumb-placeholder">
         <svg class="listing-thumb-placeholder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
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

  if (!existing) {
    card.classList.add('entering');
    getElement('listingsContainer').appendChild(card);
    scheduleCardRevealOnNextFrame();
  }
}
