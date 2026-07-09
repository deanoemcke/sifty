// Shared test fixtures for frontend specs. Consolidates what used to be five
// near-identical local `makeListing`/`makeListingItem` helpers (several of
// which used `as Listing` to bypass the compiler on incomplete literals) into
// one definition, so a future required field on `Listing`/`ListingItem`
// produces a compiler error here instead of silently untyped test data.
import type { Listing } from "../lib/recipes/base";
import type { ListingItem } from "./state";

export function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "trademe",
    title: "Test listing",
    price: 100,
    location: "Wellington",
    url: "https://example.com/listing/1",
    isAuction: false,
    relevance: 0,
    ...overrides,
  };
}

export function makeListingItem(overrides: Partial<ListingItem> = {}): ListingItem {
  return {
    data: makeListing(),
    hasBeenDeepSearched: false,
    aiCheckedHash: null,
    aiFilterReason: null,
    ...overrides,
  };
}
