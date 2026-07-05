// Pure data module — no DOM access, no I/O.
// Owns all mutable frontend state so that app.ts can import rather than declare it,
// and so that tests can call resetState() for clean isolation.

import type { Fulfillment, Listing, ListingDetail, QuickSearchProgress } from "../lib/recipes/base";

// ── Types ──────────────────────────────────────────────────────────────────────

export type UrlCardSearchStatus = "idle" | "searching" | "cancelling" | "done";

export function isSearchButtonDisabled(
  status: UrlCardSearchStatus,
  searchedUrl: string,
  inputValue: string,
): boolean {
  return (
    status === "searching" ||
    status === "cancelling" ||
    (status === "done" && searchedUrl === inputValue)
  );
}

export function canCancelSearch(status: UrlCardSearchStatus): boolean {
  return status === "searching";
}

export function isCardSearchActive(status: UrlCardSearchStatus): boolean {
  return status === "searching" || status === "cancelling";
}

export interface ListingItem {
  data: Listing;
  detail: ListingDetail | null;
  hasBeenDeepSearched: boolean;
  aiCheckedHash: number | null;
  aiFilterReason: string | null;
}

export interface DiscoverInputs {
  prompt: string;
  maxPrice?: number;
  fulfillment: Fulfillment;
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
}

export interface SavedSearch {
  id: string;
  name: string;
  urls: string[];
  discoverInputs?: DiscoverInputs;
  aiFilter: string | null;
  createdAt: number;
}

// ── State ──────────────────────────────────────────────────────────────────────

export let currentSearchName: string | null = null;
export let showFilteredListings = true;
export let isDeepSearchRunning = false;
export let deepSearchId: string | null = null;
export let deepSearchCancellationRequested = false;
export let isAiFilterRunning = false;
export let aiFilterPendingRun = false;
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
export const urlCardData: UrlCardData[] = [];
// Stable, collision-free DOM ids assigned at card insertion time via crypto.randomUUID().
// Keyed by listing URL so callers can look up a card without re-deriving its id from the URL.
export const cardIdByUrl = new Map<string, string>();

// ── Setters ────────────────────────────────────────────────────────────────────
// Plain assignment to exported `let` bindings is not visible to importers that
// have already destructured, so we expose explicit setters for the scalar flags.

export function setCurrentSearchName(name: string | null): void {
  currentSearchName = name;
}

export function setShowFilteredListings(value: boolean): void {
  showFilteredListings = value;
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

export function setOpenModalListingUrl(url: string | null): void {
  openModalListingUrl = url;
}

export function setBulkDeepSearchUrls(urls: Set<string> | null): void {
  bulkDeepSearchUrls = urls;
}

// ── Reset (for tests) ──────────────────────────────────────────────────────────

export function resetState(): void {
  currentSearchName = null;
  showFilteredListings = true;
  isDeepSearchRunning = false;
  deepSearchId = null;
  deepSearchCancellationRequested = false;
  isAiFilterRunning = false;
  aiFilterPendingRun = false;
  openModalListingUrl = null;
  bulkDeepSearchUrls = null;
  singleDeepSearchInFlightUrls.clear();
  listingsByUrl.clear();
  urlCardData.length = 0;
  cardIdByUrl.clear();
}
