// Pure data module — no DOM access, no I/O.
// Owns all mutable frontend state so that app.ts can import rather than declare it,
// and so that tests can call resetState() for clean isolation.

import type { Fulfillment, Listing, ListingDetail } from "../lib/recipes/base";

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
export let showFilteredListings = false;
export let isDeepSearchRunning = false;
export let deepSearchId: string | null = null;
export let deepSearchCancellationRequested = false;
export let isAiFilterRunning = false;
export let aiFilterPendingRun = false;
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

// ── Reset (for tests) ──────────────────────────────────────────────────────────

export function resetState(): void {
  currentSearchName = null;
  showFilteredListings = false;
  isDeepSearchRunning = false;
  deepSearchId = null;
  deepSearchCancellationRequested = false;
  isAiFilterRunning = false;
  aiFilterPendingRun = false;
  listingsByUrl.clear();
  urlCardData.length = 0;
  cardIdByUrl.clear();
}
