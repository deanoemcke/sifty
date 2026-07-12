// ── Quick search ──────────────────────────────────────────────────────────────
// Streams /api/quick-search results into a URL card row and the results grid.

import type { Listing } from '../lib/recipes/base';
import { isValidRecipeUrl } from '../lib/recipes/matcher';
import { requestAiFilterRun } from './aiFilter';
import { getElement, requireChild } from './domUtils';
import { esc } from './html';
import { listingDedupeKey } from './listingDedup';
import { applyClientFilters, renderCard, renderDerived } from './resultsView';
import { parseQuickSearchProgress } from './searchStatusText';
import {
  canCancelSearch,
  type ListingItem,
  listingsByUrl,
  type UrlCardSearchStatus,
} from './state';
import { streamPostAsync } from './streamPost';
import { renderCardStatus, resetAllResults, resetCardForResearch } from './urlCardRow';
import { type UrlCard, urlCardData } from './urlCardStore';
import { updateUrlGroupHeaders } from './urlGroupsView';

// A "listing" SSE event may replay a pre-deploy cached row that predates the
// `relevance` field becoming mandatory on `Listing`. Default it here so a
// stale cache entry can't feed `undefined`/NaN into the sort comparator.
export function normalizeListingRelevance(listing: Listing): Listing {
  return { ...listing, relevance: listing.relevance ?? 0 };
}

export async function searchUrlCardAsync(card: UrlCard): Promise<void> {
  const data = urlCardData(card);
  const url = card.dom.input.value.trim();
  if (!isValidRecipeUrl(url)) return;

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
        const dedupeKey = listingDedupeKey(listing);
        const isDuplicate = [...listingsByUrl.values()].some(
          (item) => listingDedupeKey(item.data) === dedupeKey
        );
        if (!isDuplicate) {
          data.listingUrls.push(listing.url);
          const item: ListingItem = {
            data: listing,
            hasBeenDeepSearched: false,
            aiCheckedHash: null,
            aiFilterReason: null,
          };
          listingsByUrl.set(listing.url, item);
          renderCard(item);
          renderDerived();
        } else {
          // Listing already known — either the exact URL, or the same
          // underlying listing under a different URL from another card. The
          // group count may still change, since it dedupes per group rather
          // than globally.
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
    ).addEventListener('click', clearQuickSearchCacheAsync);
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

export async function clearQuickSearchCacheAsync(): Promise<void> {
  await fetch('/api/cache/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'quick-search' }),
  }).catch(() => null);
  resetAllResults();
}
