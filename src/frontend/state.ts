// Pure data module — no DOM access, no I/O.
// Owns all mutable frontend state so that app.ts can import rather than declare it,
// and so that tests can call resetState() for clean isolation.

import { listingDedupeKey } from '../lib/listingDedup';
import type { Fulfillment, Listing, QuickSearchProgress } from '../lib/recipes/base';
import { DEFAULT_SORT_OPTION, type SortOption } from './sortListings';

// ── Types ──────────────────────────────────────────────────────────────────────

export type UrlCardSearchStatus = 'idle' | 'searching' | 'cancelling' | 'done';

export function isSearchButtonDisabled(
  status: UrlCardSearchStatus,
  searchedUrl: string,
  inputValue: string
): boolean {
  return (
    status === 'searching' ||
    status === 'cancelling' ||
    (status === 'done' && searchedUrl === inputValue)
  );
}

export function canCancelSearch(status: UrlCardSearchStatus): boolean {
  return status === 'searching';
}

export function isCardSearchActive(status: UrlCardSearchStatus): boolean {
  return status === 'searching' || status === 'cancelling';
}

export interface ListingItem {
  data: Listing;
  hasBeenDeepSearched: boolean;
  aiCheckedHash: number | null;
  aiFilterReason: string | null;
  // Client-side inference from the card's search URL (condition=new /
  // itemCondition=new), never server-scraped data — kept off the shared
  // `Listing` domain type for that reason. See isNewConditionSearchUrl in
  // quickSearch.ts.
  isNewFromSearch: boolean;
}

export interface DiscoverInputs {
  prompt: string;
  maxPrice?: number;
  fulfillment: Fulfillment;
  includeSoldItems?: boolean;
  includeNewItems?: boolean;
  region?: string;
}

export interface UrlCardData {
  searchStatus: UrlCardSearchStatus;
  searchedUrl: string;
  searchId: string | null;
  listingUrls: string[];
  // Latest structured progress event, rendered on the row's status line.
  lastProgress: QuickSearchProgress | null;
  errorMessage: string | null;
  wasCancelled: boolean;
  // True from the edit button being clicked until a new search starts —
  // keeps the input shown (instead of the link) without touching the
  // previous search's criteria/status/cache display.
  isEditing: boolean;
}

export interface SavedSearch {
  id: string;
  name: string;
  urls: string[];
  discoverInputs?: DiscoverInputs;
  aiFilter: string | null;
  createdAt: number;
  shouldAlertOnNewListings: boolean;
}

// ── State ──────────────────────────────────────────────────────────────────────

export type ListingVisibilityCategory = 'used' | 'sold' | 'new' | 'filtered';

export function getListingCategory(item: ListingItem): ListingVisibilityCategory {
  if (item.aiFilterReason !== null) return 'filtered';
  if (item.data.isSold) return 'sold';
  if (item.isNewFromSearch) return 'new';
  return 'used';
}

export const ALL_LISTING_VISIBILITY_CATEGORIES: ListingVisibilityCategory[] = [
  'used',
  'sold',
  'new',
  'filtered',
];

// 'filtered' starts hidden — those listings were excluded by the AI filter,
// so the default view shouldn't show them until the user opts back in.
const DEFAULT_VISIBLE_LISTING_CATEGORIES = ALL_LISTING_VISIBILITY_CATEGORIES.filter(
  (category) => category !== 'filtered'
);

export let currentSearchName: string | null = null;
export let currentSearchId: string | null = null;
// The mutable set stays private so every write goes through
// setListingCategoryVisible — importers only see a ReadonlySet.
const mutableVisibleListingCategories = new Set<ListingVisibilityCategory>(
  DEFAULT_VISIBLE_LISTING_CATEGORIES
);
export const visibleListingCategories: ReadonlySet<ListingVisibilityCategory> =
  mutableVisibleListingCategories;
export let isDeepSearchRunning = false;
export let deepSearchId: string | null = null;
export let deepSearchCancellationRequested = false;
export let isAiFilterRunning = false;
export let aiFilterPendingRun = false;
export let sortBy: SortOption = DEFAULT_SORT_OPTION;
// Which listing's detail modal is open, if any — used to guard against a
// stale deep-search response writing into a modal that has since closed or
// switched to a different listing.
export let openModalListingUrl: string | null = null;
// URLs covered by the in-flight bulk deep search, if one is running — lets a
// card click detect "this listing is already being fetched" and avoid a
// duplicate request.
export let bulkDeepSearchUrls: Set<string> | null = null;
// URLs currently being fetched via a modal-triggered single-listing deep
// search, to dedupe re-clicks/re-opens of the same listing's modal.
export const singleDeepSearchInFlightUrls = new Set<string>();
export const listingsByUrl = new Map<string, ListingItem>();
// Second index over the same listings, keyed by listingDedupeKey's raw
// composite string (not a hash of it — see listingDedup.ts) rather than by
// URL. Lets content-based duplicate detection (the same listing surfacing
// under two different URLs) be an O(1) lookup instead of rescanning every
// stored listing on every incoming SSE event. This mirrors listingsByUrl, so
// it must only ever be written to via addListingItem/removeListingByUrl/
// clearListings below — never listingsByUrl.set/delete/clear directly —
// to keep the two maps from drifting apart.
export const listingUrlByDedupeKey = new Map<string, string>();
export const urlCardDataById = new Map<string, UrlCardData>();
// Stable, collision-free DOM ids assigned at card insertion time via crypto.randomUUID().
// Keyed by listing URL so callers can look up a card without re-deriving its id from the URL.
export const cardIdByUrl = new Map<string, string>();

// ── Setters ────────────────────────────────────────────────────────────────────
// Plain assignment to exported `let` bindings is not visible to importers that
// have already destructured, so we expose explicit setters for the scalar flags.

export function setCurrentSearchName(name: string | null): void {
  currentSearchName = name;
}

export function setCurrentSearchId(id: string | null): void {
  currentSearchId = id;
}

export function setIsDeepSearchRunning(value: boolean): void {
  isDeepSearchRunning = value;
}

export function setDeepSearchId(id: string | null): void {
  deepSearchId = id;
}

export function setDeepSearchCancellationRequested(value: boolean): void {
  deepSearchCancellationRequested = value;
}

export function setIsAiFilterRunning(value: boolean): void {
  isAiFilterRunning = value;
}

export function setAiFilterPendingRun(value: boolean): void {
  aiFilterPendingRun = value;
}

export function setSortBy(value: SortOption): void {
  sortBy = value;
}

export function setListingCategoryVisible(
  category: ListingVisibilityCategory,
  isVisible: boolean
): void {
  if (isVisible) mutableVisibleListingCategories.add(category);
  else mutableVisibleListingCategories.delete(category);
}

export function setOpenModalListingUrl(url: string | null): void {
  openModalListingUrl = url;
}

export function setBulkDeepSearchUrls(urls: Set<string> | null): void {
  bulkDeepSearchUrls = urls;
}

// ── Listing storage (keeps listingsByUrl and listingUrlByDedupeKey in sync) ─────
// These are the only functions permitted to write to either map, so the two
// indexes can never drift apart.

export function addListingItem(item: ListingItem): void {
  listingsByUrl.set(item.data.url, item);
  listingUrlByDedupeKey.set(listingDedupeKey(item.data), item.data.url);
}

export function removeListingByUrl(url: string): void {
  const item = listingsByUrl.get(url);
  if (item) listingUrlByDedupeKey.delete(listingDedupeKey(item.data));
  listingsByUrl.delete(url);
}

export function clearListings(): void {
  listingsByUrl.clear();
  listingUrlByDedupeKey.clear();
}

// ── Reset (for tests) ──────────────────────────────────────────────────────────

export function resetState(): void {
  currentSearchName = null;
  currentSearchId = null;
  mutableVisibleListingCategories.clear();
  for (const category of DEFAULT_VISIBLE_LISTING_CATEGORIES)
    mutableVisibleListingCategories.add(category);
  isDeepSearchRunning = false;
  deepSearchId = null;
  deepSearchCancellationRequested = false;
  isAiFilterRunning = false;
  aiFilterPendingRun = false;
  sortBy = DEFAULT_SORT_OPTION;
  openModalListingUrl = null;
  bulkDeepSearchUrls = null;
  singleDeepSearchInFlightUrls.clear();
  clearListings();
  urlCardDataById.clear();
  cardIdByUrl.clear();
}
