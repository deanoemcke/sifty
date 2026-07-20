// ── URL state ─────────────────────────────────────────────────────────────────
// Derives the browser address bar's query string from state.ts (never the
// other way round — the URL is always a projection of state.ts, not a second
// copy of it) so back/forward moves through real app states: sidebar tab,
// sort, visible categories, the open listing modal, and a loaded saved
// search. Ad-hoc (unsaved) session content — the url-card list, discover
// inputs, AI-filter text — is deliberately out of scope here; see
// draftSession.ts for how that survives a reload instead.

import { closeListingModal, openListingModalAsync } from './listingDetail';
import { applyClientFilters } from './resultsView';
import { loadSavedSearchAsync, unloadCurrentSearch } from './searchSession';
import { renderShowControls } from './showDropdown';
import { activateSidebarTab, type SidebarTabName } from './sidebarTabs';
import { renderSortControls } from './sortDropdown';
import { DEFAULT_SORT_OPTION, SORT_OPTIONS, type SortOption } from './sortListings';
import {
  ALL_LISTING_VISIBILITY_CATEGORIES,
  activeSidebarTab,
  currentSearchId,
  type ListingVisibilityCategory,
  listingsByUrl,
  openModalListingUrl,
  setActiveSidebarTab,
  setListingCategoryVisible,
  setSortBy,
  sortBy,
  visibleListingCategories,
} from './state';

export interface ParsedUrlState {
  tab: SidebarTabName;
  sort: SortOption;
  visibleCategories: ReadonlySet<ListingVisibilityCategory>;
  modalListingUrl: string | null;
  savedSearchId: string | null;
}

// Fixed order keeps serialized `show` values deterministic (and diff-stable
// across boots) rather than depending on Set insertion order.
const SHOW_TOKEN_ORDER: ListingVisibilityCategory[] = ['used', 'sold', 'new', 'filtered'];

const SORT_OPTION_VALUES = new Set(SORT_OPTIONS.map((option) => option.value));

export function serializeStateToSearchParams(): URLSearchParams {
  const params = new URLSearchParams();
  if (activeSidebarTab !== 'search') params.set('tab', activeSidebarTab);
  if (sortBy !== DEFAULT_SORT_OPTION) params.set('sort', sortBy);
  const visibleTokens = SHOW_TOKEN_ORDER.filter((category) =>
    visibleListingCategories.has(category)
  );
  if (visibleTokens.length !== ALL_LISTING_VISIBILITY_CATEGORIES.length) {
    params.set('show', visibleTokens.join(','));
  }
  if (openModalListingUrl !== null) params.set('modal', openModalListingUrl);
  if (currentSearchId !== null) params.set('search', currentSearchId);
  return params;
}

function parseTab(params: URLSearchParams): SidebarTabName {
  return params.get('tab') === 'favourites' ? 'favourites' : 'search';
}

function parseSort(params: URLSearchParams): SortOption {
  const value = params.get('sort');
  return value !== null && SORT_OPTION_VALUES.has(value as SortOption)
    ? (value as SortOption)
    : DEFAULT_SORT_OPTION;
}

function parseVisibleCategories(params: URLSearchParams): ReadonlySet<ListingVisibilityCategory> {
  const raw = params.get('show');
  if (raw === null) return new Set(ALL_LISTING_VISIBILITY_CATEGORIES);
  const tokens = raw
    .split(',')
    .filter((token): token is ListingVisibilityCategory =>
      (ALL_LISTING_VISIBILITY_CATEGORIES as string[]).includes(token)
    );
  return tokens.length > 0 ? new Set(tokens) : new Set(ALL_LISTING_VISIBILITY_CATEGORIES);
}

export function parseUrlState(params: URLSearchParams): ParsedUrlState {
  return {
    tab: parseTab(params),
    sort: parseSort(params),
    visibleCategories: parseVisibleCategories(params),
    modalListingUrl: params.get('modal'),
    savedSearchId: params.get('search'),
  };
}

export function currentLocationSearchParams(): URLSearchParams {
  return new URLSearchParams(location.search);
}

// Sole writer of the address bar for in-app state changes. `push: true` adds
// a real back-stop, tagging the new entry with URL_STATE_PUSH_MARKER so a
// later close/back decision can tell "this app pushed this entry" apart from
// "the address bar just happens to carry a matching URL" — e.g. a
// boot-time deep link, which never goes through this function's push branch
// (see isAppPushedModalEntryFor below and bootFromPersistedStateAsync in
// app.ts). `push: false` (replaceState) reflects the current state without
// growing history, carrying the existing entry's state (and marker, if any)
// forward instead of clearing it.
const URL_STATE_PUSH_MARKER = { siftyPushed: true } as const;

export function syncUrlToState(options: { push: boolean }): void {
  const url = `${location.pathname}?${serializeStateToSearchParams().toString()}${location.hash}`;
  if (options.push) history.pushState(URL_STATE_PUSH_MARKER, '', url);
  else history.replaceState(history.state, '', url);
}

// Was the *current* history entry both pushed by this app (via
// syncUrlToState({ push: true })) and does it still carry this listing as
// the open modal? Both must hold before closing the modal may call
// history.back() — a boot-time deep link (or any URL that merely happens to
// match) carries no marker, so this correctly returns false for it and the
// caller falls back to replacing the URL instead of calling back() with no
// app-pushed entry to consume.
export function isAppPushedModalEntryFor(listingUrl: string): boolean {
  const state = history.state as { siftyPushed?: boolean } | null;
  return state?.siftyPushed === true && currentLocationSearchParams().get('modal') === listingUrl;
}

async function fetchSavedSearchById(
  id: string
): Promise<Parameters<typeof loadSavedSearchAsync>[0] | null> {
  try {
    const response = await fetch(`/api/saved-searches/${id}`);
    if (!response.ok) return null;
    const { search } = (await response.json()) as {
      search: Parameters<typeof loadSavedSearchAsync>[0];
    };
    return search;
  } catch {
    return null;
  }
}

export async function applyUrlState(parsed: ParsedUrlState): Promise<void> {
  setActiveSidebarTab(parsed.tab);
  activateSidebarTab(document, parsed.tab);

  setSortBy(parsed.sort);
  renderSortControls(parsed.sort);

  for (const category of ALL_LISTING_VISIBILITY_CATEGORIES) {
    setListingCategoryVisible(category, parsed.visibleCategories.has(category));
  }
  renderShowControls();
  applyClientFilters();

  if (parsed.savedSearchId !== null) {
    if (parsed.savedSearchId !== currentSearchId) {
      // An unresolvable id (404, or a network failure) leaves the session as
      // it already was rather than surfacing an error — the URL may simply
      // be stale (the favourite was since deleted) or offline.
      const search = await fetchSavedSearchById(parsed.savedSearchId);
      if (search) await loadSavedSearchAsync(search);
    }
  } else if (currentSearchId !== null) {
    unloadCurrentSearch();
  }

  if (parsed.modalListingUrl !== null) {
    const item = listingsByUrl.get(parsed.modalListingUrl);
    if (item) await openListingModalAsync(item);
    else if (openModalListingUrl !== null) closeListingModal();
  } else if (openModalListingUrl !== null) {
    closeListingModal();
  }
}
