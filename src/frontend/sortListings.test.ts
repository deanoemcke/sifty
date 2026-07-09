// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Listing } from "../lib/recipes/base";
import {
  DEFAULT_SORT_OPTION,
  populateSortSelect,
  SORT_OPTIONS,
  type SortOption,
  sortListings,
} from "./sortListings";
import type { ListingItem } from "./state";

function makeListingItem(url: string, relevance: number, price: number | null): ListingItem {
  return {
    data: { source: "trademe", title: url, price, location: "", url, relevance } as Listing,
    hasBeenDeepSearched: false,
    aiCheckedHash: null,
    aiFilterReason: null,
  };
}

describe("sortListings", () => {
  it("leaves source-url order untouched", () => {
    const listings = [
      makeListingItem("a", 3, 10),
      makeListingItem("b", 9, 5),
      makeListingItem("c", 1, 20),
    ];
    expect(sortListings(listings, "source-url").map((item) => item.data.url)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("sorts by relevance descending for best-match, preserving order on ties", () => {
    const listings = [
      makeListingItem("a", 3, 10),
      makeListingItem("b", 9, 5),
      makeListingItem("c", 3, 20),
    ];
    expect(sortListings(listings, "best-match").map((item) => item.data.url)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sorts by relevance ascending for worst-match, preserving order on ties", () => {
    const listings = [
      makeListingItem("a", 3, 10),
      makeListingItem("b", 9, 5),
      makeListingItem("c", 3, 20),
    ];
    expect(sortListings(listings, "worst-match").map((item) => item.data.url)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("sorts by price ascending for lowest-price, with null prices last", () => {
    const listings = [
      makeListingItem("a", 0, 30),
      makeListingItem("b", 0, null),
      makeListingItem("c", 0, 10),
    ];
    expect(sortListings(listings, "lowest-price").map((item) => item.data.url)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("sorts by price descending for highest-price, with null prices still last", () => {
    const listings = [
      makeListingItem("a", 0, 30),
      makeListingItem("b", 0, null),
      makeListingItem("c", 0, 10),
    ];
    expect(sortListings(listings, "highest-price").map((item) => item.data.url)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("preserves original order for equal prices", () => {
    const listings = [
      makeListingItem("a", 0, 10),
      makeListingItem("b", 0, 10),
      makeListingItem("c", 0, 5),
    ];
    expect(sortListings(listings, "lowest-price").map((item) => item.data.url)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("does not mutate the input array", () => {
    const listings = [makeListingItem("a", 1, 10), makeListingItem("b", 9, 5)];
    const original = [...listings];
    sortListings(listings, "best-match");
    expect(listings).toEqual(original);
  });
});

describe("SORT_OPTIONS / DEFAULT_SORT_OPTION", () => {
  it("defaults to source-url", () => {
    expect(DEFAULT_SORT_OPTION).toBe("source-url");
  });

  it("lists all five options in the required order", () => {
    expect(SORT_OPTIONS.map((option) => option.value)).toEqual([
      "source-url",
      "best-match",
      "worst-match",
      "lowest-price",
      "highest-price",
    ]);
  });
});

describe("populateSortSelect", () => {
  it("appends an option per entry and selects the default", () => {
    const select = document.createElement("select");
    populateSortSelect(select, SORT_OPTIONS, "best-match" as SortOption);
    expect(select.options.length).toBe(SORT_OPTIONS.length);
    expect(select.value).toBe("best-match");
    expect(select.options[1].textContent).toBe("Best match");
  });
});
