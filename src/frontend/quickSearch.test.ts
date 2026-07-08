// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchUrlCardAsync } from "./quickSearch";
import { cardStatusText } from "./searchStatusText";
import { resetState, type UrlCardData } from "./state";
import { cancelSearch, cardStatusSnapshot } from "./urlCardRow";
import {
  addUrlCard,
  resetUrlCardStore,
  type UrlCard,
  type UrlCardDom,
  urlCardData,
} from "./urlCardStore";

const TRADEME_URL = "https://www.trademe.co.nz/search/test";

function makeCardData(): UrlCardData {
  return {
    searchStatus: "idle",
    searchedUrl: "",
    searchId: null,
    listingUrls: [],
    lastProgress: null,
    errorMessage: null,
    wasCancelled: false,
  };
}

function makeCardDom(url: string): UrlCardDom {
  const criteriaElement = document.createElement("div");
  criteriaElement.innerHTML = '<div class="criteria-grid"></div>';
  const input = document.createElement("input");
  input.value = url;
  return {
    containerElement: document.createElement("div"),
    input,
    linkElement: document.createElement("a"),
    searchButton: document.createElement("button"),
    removeButton: document.createElement("button"),
    criteriaElement,
    cacheStatusElement: document.createElement("div"),
    statusElement: document.createElement("div"),
  };
}

// Stubs the fetch call `streamPostAsync` makes, streaming one line per chunk
// so each is processed on its own tick — matching how a real SSE response
// interleaves with other async work (e.g. a cancel-button click) between reads.
// `onBeforeRead` runs before each `read()` settles, keyed by call index.
function stubQuickSearchStream(chunks: string[], onBeforeRead?: (callIndex: number) => void): void {
  const encoder = new TextEncoder();
  const pendingChunks = [...chunks];
  let callIndex = 0;
  const reader = {
    read: async () => {
      onBeforeRead?.(callIndex);
      callIndex += 1;
      return pendingChunks.length > 0
        ? { value: encoder.encode(pendingChunks.shift()), done: false }
        : { value: undefined, done: true };
    },
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

function addSearchableCard(): UrlCard {
  return addUrlCard(makeCardDom(TRADEME_URL), makeCardData());
}

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  document.body.innerHTML = `
    <div id="resultsSection" class="hidden"></div>
    <div id="urlCardsContainer"></div>
    <span id="resultCount"></span>
    <span id="filteredCountNum"></span>
    <span id="filteredCount"></span>
    <button id="deepBtn"></button>
    <textarea id="aiFilter"></textarea>
    <button id="applyAiFilterBtn"></button>
  `;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchUrlCardAsync — post-stream cancellation disambiguation", () => {
  it("marks the search cancelled when cancelSearch fires while the stream is still being read", async () => {
    const card = addSearchableCard();
    stubQuickSearchStream(['data: {"type":"progress","phase":"loading"}\n'], (callIndex) => {
      // Simulates the user clicking cancel in the gap between two network reads.
      if (callIndex === 1) cancelSearch(card);
    });

    await searchUrlCardAsync(card);

    const data = urlCardData(card);
    expect(data.searchStatus).toBe("idle");
    expect(data.wasCancelled).toBe(true);
    expect(cardStatusText(cardStatusSnapshot(card))).toEqual({
      text: "Cancelled — 0 listings",
      kind: "error",
    });
  });

  it("marks the search done, not cancelled, when the stream finishes without an intervening cancel", async () => {
    const card = addSearchableCard();
    stubQuickSearchStream(['data: {"type":"progress","phase":"loading"}\n']);

    await searchUrlCardAsync(card);

    const data = urlCardData(card);
    expect(data.searchStatus).toBe("done");
    expect(data.wasCancelled).toBe(false);
  });
});
