// ── Quick search ──────────────────────────────────────────────────────────────
// Streams /api/quick-search results into a URL card row and the results grid.

import { listingDedupeKey } from '../lib/listingDedup';
import type { Listing } from '../lib/recipes/base';
import { isValidRecipeUrl } from '../lib/recipes/matcher';
import { requestAiFilterRun } from './aiFilter';
import { getElement, requireChild } from './domUtils';
import { esc } from './html';
import { applyClientFilters, renderCard, renderDerived } from './resultsView';
import { parseQuickSearchProgress } from './searchStatusText';
import {
  addListingItem,
  canCancelSearch,
  type ListingItem,
  listingsByUrl,
  listingUrlByDedupeKey,
  type UrlCardSearchStatus,
} from './state';
import { streamPostAsync } from './streamPost';
import { renderCardStatus, resetCardForResearch } from './urlCardRow';
import { type UrlCard, urlCardData } from './urlCardStore';
import { updateUrlGroupHeaders } from './urlGroupsView';

// A "listing" SSE event may replay a pre-deploy cached row that predates the
// `relevance` field becoming mandatory on `Listing`. Default it here so a
// stale cache entry can't feed `undefined`/NaN into the sort comparator.
export function normalizeListingRelevance(listing: Listing): Listing {
  return { ...listing, relevance: listing.relevance ?? 0 };
}

// Condition (new vs used) is never present in a listing's quick-search data on
// either platform — TradeMe's search API and Facebook's grid-card scrape both
// only surface it via a per-listing detail fetch (deep search), which quick
// search never runs. So the only signal available at ingestion time is which
// condition the card's own search URL queried for.
export function isNewConditionSearchUrl(searchUrl: string): boolean {
  try {
    const params = new URL(searchUrl).searchParams;
    return params.get('condition') === 'new' || params.get('itemCondition') === 'new';
  } catch {
    return false;
  }
}

export async function searchUrlCardAsync(card: UrlCard): Promise<void> {
  const data = urlCardData(card);
  const url = card.dom.input.value.trim();
  if (!isValidRecipeUrl(url)) return;

  data.isEditing = false;
  if (data.searchStatus === 'done') resetCardForResearch(card);

  getElement('resultsSection').classList.remove('hidden');
  data.searchStatus = 'searching';
  data.searchId = crypto.randomUUID();
  data.lastProgress = null;
  data.errorMessage = null;
  data.wasCancelled = false;
  renderDerived();
  renderCardStatus(card);

  let cachedAge = '';
  try {
    await streamPostAsync('/api/quick-search', { url, searchId: data.searchId }, (ev) => {
      if (ev.type === 'criteria') {
        const filters = ev.filters as Array<[string, string]>;
        requireChild<HTMLElement>(card.dom.criteriaElement, '.criteria-grid').innerHTML = filters
          .map(
            ([k, v]) =>
              `<div class="criteria-row"><span class="criteria-key">${esc(k)}</span><span class="criteria-val">${esc(v)}</span></div>`
          )
          .join('');
        card.dom.criteriaElement.classList.remove('hidden');
      } else if (ev.type === 'cached') {
        cachedAge = ev.age as string;
      } else if (ev.type === 'progress') {
        const progress = parseQuickSearchProgress(ev);
        if (progress === null) {
          console.warn('Ignoring malformed progress event', ev);
        } else {
          data.lastProgress = progress;
          if (canCancelSearch(data.searchStatus)) renderCardStatus(card);
          updateUrlGroupHeaders();
        }
      } else if (ev.type === 'listing') {
        const listing = normalizeListingRelevance(ev.data as Listing);
        const isNewFromThisSearch = isNewConditionSearchUrl(url);
        const dedupeKey = listingDedupeKey(listing);
        const existingUrl = listingUrlByDedupeKey.get(dedupeKey);
        if (existingUrl === undefined) {
          data.listingUrls.push(listing.url);
          const item: ListingItem = {
            data: listing,
            hasBeenDeepSearched: false,
            aiCheckedHash: null,
            aiFilterReason: null,
            isNewFromSearch: isNewFromThisSearch,
          };
          addListingItem(item);
          renderCard(item);
          renderDerived();
        } else {
          // Listing already known — either the exact URL, or the same
          // underlying listing under a different URL from another card
          // (e.g. discovery's "used" and "new" cards racing on the same
          // item). Merge deterministically rather than first-write-wins: a
          // listing found by any condition=new search is new, regardless of
          // which arrival happened to land first. An existing
          // isNewFromSearch: true is therefore never downgraded by a later,
          // less-specific arrival.
          const existingItem = listingsByUrl.get(existingUrl);
          if (existingItem && isNewFromThisSearch && !existingItem.isNewFromSearch) {
            existingItem.isNewFromSearch = true;
            renderCard(existingItem);
            renderDerived();
          }
          // The group count may still change, since it dedupes per group
          // rather than globally.
          updateUrlGroupHeaders();
        }
      } else if (ev.type === 'error') {
        data.errorMessage = typeof ev.message === 'string' ? ev.message : 'Search failed';
      }
    });
  } catch (error) {
    data.errorMessage = (error as Error).message;
  }

  const wasCancelled = (data.searchStatus as UrlCardSearchStatus) === 'cancelling';
  data.searchStatus = wasCancelled ? 'idle' : 'done';
  data.searchId = null;

  if (wasCancelled) {
    data.wasCancelled = true;
    renderCardStatus(card);
    if (listingsByUrl.size > 0) applyClientFilters();
    return;
  }
  data.searchedUrl = url;
  card.dom.input.readOnly = true;

  if (cachedAge) {
    card.dom.cacheStatusElement.innerHTML = `Loaded from cache — ${esc(cachedAge)} <button class="cache-clear-btn">Clear</button>`;
    card.dom.cacheStatusElement.classList.remove('hidden');
    requireChild<HTMLButtonElement>(
      card.dom.cacheStatusElement,
      '.cache-clear-btn'
    ).addEventListener('click', () => clearQuickSearchCacheAsync(card));
  }

  renderCardStatus(card);
  if (listingsByUrl.size > 0) {
    applyClientFilters();
    const aiPrompt = getElement<HTMLTextAreaElement>('aiFilter').value.trim();
    if (aiPrompt) requestAiFilterRun();
  } else {
    renderDerived();
  }
}

export async function clearQuickSearchCacheAsync(card: UrlCard): Promise<void> {
  const url = urlCardData(card).searchedUrl;
  await fetch('/api/cache/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'quick-search', url }),
  }).catch(() => null);
  await searchUrlCardAsync(card);
}
