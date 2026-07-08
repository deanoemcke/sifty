// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { Listing } from "../lib/recipes/base";
import { getOrderedListings, renderDerived, renderFilteredToggle } from "./resultsView";
import {
  type ListingItem,
  listingsByUrl,
  resetState,
  setIsAiFilterRunning,
  setShowFilteredListings,
  type UrlCardData,
} from "./state";
import { addUrlCard, resetUrlCardStore, type UrlCardDom } from "./urlCardStore";

function makeListingItem(url: string): ListingItem {
  return {
    data: {
      source: "trademe",
      title: url,
      price: null,
      location: "",
      url,
    } as Listing,
    hasBeenDeepSearched: false,
    aiCheckedHash: null,
    aiFilterReason: null,
  };
}

function addCardWithListings(listingUrls: string[]): void {
  const data: UrlCardData = {
    searchStatus: "done",
    searchedUrl: "",
    searchId: null,
    listingUrls,
    lastProgress: null,
    errorMessage: null,
    wasCancelled: false,
  };
  addUrlCard({ input: document.createElement("input") } as UrlCardDom, data);
  for (const url of listingUrls) {
    if (!listingsByUrl.has(url)) listingsByUrl.set(url, makeListingItem(url));
  }
}

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  document.body.innerHTML = `
    <button id="toggleFilteredBtn"></button>
    <span id="resultCount"></span>
    <span id="totalCount"></span>
    <button id="deepBtn"></button>
    <span id="aiFilterStatus"></span>
  `;
});

describe("getOrderedListings", () => {
  it("preserves card order and dedupes cross-card listings", () => {
    addCardWithListings(["https://l/1", "https://l/2"]);
    addCardWithListings(["https://l/2", "https://l/3"]);
    const orderedUrls = getOrderedListings().map((item) => item.data.url);
    expect(orderedUrls).toEqual(["https://l/1", "https://l/2", "https://l/3"]);
  });

  it("skips listing urls with no entry in listingsByUrl", () => {
    addCardWithListings(["https://l/1"]);
    listingsByUrl.delete("https://l/1");
    expect(getOrderedListings()).toEqual([]);
  });
});

describe("renderDerived", () => {
  it("counts only passing listings as visible when filtered listings are hidden", () => {
    addCardWithListings(["https://l/1", "https://l/2"]);
    listingsByUrl.get("https://l/2")!.aiFilterReason = "too old";
    setShowFilteredListings(false);
    renderDerived();
    expect(document.getElementById("resultCount")!.textContent).toBe("1");
    expect(document.getElementById("totalCount")!.textContent).toBe("2");
  });

  it("counts all listings as visible when filtered listings are shown", () => {
    addCardWithListings(["https://l/1", "https://l/2"]);
    listingsByUrl.get("https://l/2")!.aiFilterReason = "too old";
    setShowFilteredListings(true);
    renderDerived();
    expect(document.getElementById("resultCount")!.textContent).toBe("2");
    expect(document.getElementById("totalCount")!.textContent).toBe("2");
  });

  it("shows a zero count before any listing has been excluded", () => {
    addCardWithListings(["https://l/1", "https://l/2"]);
    renderDerived();
    expect(document.getElementById("aiFilterStatus")!.textContent).toBe("Filtered 0 results");
  });

  it("counts excluded listings in the ai-filter status line", () => {
    addCardWithListings(["https://l/1", "https://l/2", "https://l/3"]);
    listingsByUrl.get("https://l/2")!.aiFilterReason = "too old";
    listingsByUrl.get("https://l/3")!.aiFilterReason = "wrong colour";
    renderDerived();
    expect(document.getElementById("aiFilterStatus")!.textContent).toBe("Filtered 2 results");
  });

  it("shows a spinner and filtering message while the ai filter is running", () => {
    addCardWithListings(["https://l/1"]);
    setIsAiFilterRunning(true);
    renderDerived();
    const status = document.getElementById("aiFilterStatus")!;
    expect(status.querySelector(".spinner")).not.toBeNull();
    expect(status.textContent).toContain("Filtering results...");
  });

  it("reverts to the filtered count once the ai filter run finishes", () => {
    addCardWithListings(["https://l/1", "https://l/2"]);
    listingsByUrl.get("https://l/2")!.aiFilterReason = "too old";
    setIsAiFilterRunning(true);
    renderDerived();
    setIsAiFilterRunning(false);
    renderDerived();
    expect(document.getElementById("aiFilterStatus")!.textContent).toBe("Filtered 1 results");
  });
});

describe("renderFilteredToggle", () => {
  it("derives the pressed state and label from showFilteredListings state", () => {
    setShowFilteredListings(true);
    renderFilteredToggle();
    const toggleBtn = document.getElementById("toggleFilteredBtn") as HTMLButtonElement;
    expect(toggleBtn.getAttribute("aria-pressed")).toBe("true");
    expect(toggleBtn.title).toBe("Hide filtered listings");

    setShowFilteredListings(false);
    renderFilteredToggle();
    expect(toggleBtn.getAttribute("aria-pressed")).toBe("false");
    expect(toggleBtn.title).toBe("Show filtered listings");
  });
});
