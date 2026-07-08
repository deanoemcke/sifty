// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Listing } from "../lib/recipes/base";
import { runAiFilterAsync, scheduleAiFilterRun } from "./aiFilter";
import { type ListingItem, listingsByUrl, resetState } from "./state";
import { addUrlCard, resetUrlCardStore, type UrlCardDom } from "./urlCardStore";

describe("scheduleAiFilterRun", () => {
  it("calls runAiFilterAsync when the filter is not already running", () => {
    const runAiFilterAsync = vi.fn();
    const setAiFilterPendingRun = vi.fn();

    scheduleAiFilterRun({
      isAiFilterRunning: false,
      runAiFilterAsync,
      setAiFilterPendingRun,
    });

    expect(runAiFilterAsync).toHaveBeenCalledOnce();
    expect(setAiFilterPendingRun).not.toHaveBeenCalled();
  });

  it("sets aiFilterPendingRun to true and does not call runAiFilterAsync when the filter is already running", () => {
    const runAiFilterAsync = vi.fn();
    const setAiFilterPendingRun = vi.fn();

    scheduleAiFilterRun({
      isAiFilterRunning: true,
      runAiFilterAsync,
      setAiFilterPendingRun,
    });

    expect(setAiFilterPendingRun).toHaveBeenCalledOnce();
    expect(setAiFilterPendingRun).toHaveBeenCalledWith(true);
    expect(runAiFilterAsync).not.toHaveBeenCalled();
  });
});

// Stubs the fetch call `streamPostAsync` makes, streaming one line per chunk —
// mirrors stubQuickSearchStream in quickSearch.test.ts.
function stubAiFilterStream(chunks: string[]): void {
  const encoder = new TextEncoder();
  const pendingChunks = [...chunks];
  const reader = {
    read: async () =>
      pendingChunks.length > 0
        ? { value: encoder.encode(pendingChunks.shift()), done: false }
        : { value: undefined, done: true },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: { getReader: () => reader },
    }),
  );
}

function makeCardDom(): UrlCardDom {
  const criteriaElement = document.createElement("div");
  criteriaElement.innerHTML = '<div class="criteria-grid"></div>';
  return {
    containerElement: document.createElement("div"),
    input: document.createElement("input"),
    linkElement: document.createElement("a"),
    searchButton: document.createElement("button"),
    removeButton: document.createElement("button"),
    criteriaElement,
    cacheStatusElement: document.createElement("div"),
    statusElement: document.createElement("div"),
  };
}

function makeListing(url: string): Listing {
  return {
    source: "trademe",
    title: "Item",
    price: 100,
    location: "Auckland",
    url,
    isAuction: false,
    relevance: 0,
  };
}

describe("runAiFilterAsync", () => {
  beforeEach(() => {
    resetState();
    resetUrlCardStore();
    document.body.innerHTML = `
      <div id="resultsSection" class="hidden"></div>
      <div id="listingsContainer"></div>
      <span id="resultCount"></span>
      <span id="filteredCountNum"></span>
      <span id="filteredCount"></span>
      <button id="deepBtn"></button>
      <textarea id="aiFilter">laptop</textarea>
      <button id="applyAiFilterBtn"></button>
    `;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the AI-assigned relevance score onto the listing when a result event arrives", async () => {
    const url = "https://example.com/1";
    const item: ListingItem = {
      data: makeListing(url),
      hasBeenDeepSearched: false,
      aiCheckedHash: null,
      aiFilterReason: null,
    };
    listingsByUrl.set(url, item);
    addUrlCard(makeCardDom(), {
      searchStatus: "done",
      searchedUrl: url,
      searchId: null,
      listingUrls: [url],
      lastProgress: null,
      errorMessage: null,
      wasCancelled: false,
    });

    stubAiFilterStream([
      `data: {"type":"result","results":[{"url":"${url}","pass":true,"reason":null,"relevance":7}]}\n`,
    ]);

    await runAiFilterAsync();

    expect(item.data.relevance).toBe(7);
  });
});
