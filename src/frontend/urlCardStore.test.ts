import { beforeEach, describe, expect, it } from "vitest";
import { resetState, type UrlCardData, urlCardData } from "./state";
import {
  addUrlCard,
  removeUrlCardEntry,
  resetUrlCardStore,
  type UrlCard,
  type UrlCardDom,
  urlCards,
} from "./urlCardStore";

function makeCardData(searchedUrl: string): UrlCardData {
  return {
    searchStatus: "idle",
    searchedUrl,
    searchId: null,
    listingUrls: [],
    lastProgress: null,
    errorMessage: null,
    wasCancelled: false,
  };
}

// The store pairs serialisable data with live DOM handles; tests only exercise
// the pairing invariant, so stub handles are sufficient.
function makeCard(searchedUrl: string): UrlCard {
  return { data: makeCardData(searchedUrl), dom: {} as UrlCardDom };
}

beforeEach(() => {
  resetState();
  resetUrlCardStore();
});

describe("addUrlCard", () => {
  it("keeps urlCards and state.urlCardData index-aligned", () => {
    const first = makeCard("https://example.com/1");
    const second = makeCard("https://example.com/2");
    addUrlCard(first);
    addUrlCard(second);
    expect(urlCards).toHaveLength(2);
    expect(urlCardData).toHaveLength(2);
    expect(urlCardData[0]).toBe(first.data);
    expect(urlCardData[1]).toBe(second.data);
  });
});

describe("removeUrlCardEntry", () => {
  it("splices both arrays at the same index", () => {
    const first = makeCard("https://example.com/1");
    const second = makeCard("https://example.com/2");
    const third = makeCard("https://example.com/3");
    addUrlCard(first);
    addUrlCard(second);
    addUrlCard(third);

    removeUrlCardEntry(second);

    expect(urlCards).toEqual([first, third]);
    expect(urlCardData).toEqual([first.data, third.data]);
  });

  it("leaves both arrays untouched for an unknown card", () => {
    const known = makeCard("https://example.com/1");
    addUrlCard(known);
    removeUrlCardEntry(makeCard("https://example.com/ghost"));
    expect(urlCards).toHaveLength(1);
    expect(urlCardData).toHaveLength(1);
  });
});

describe("resetUrlCardStore", () => {
  it("clears the card list for test isolation", () => {
    addUrlCard(makeCard("https://example.com/1"));
    resetUrlCardStore();
    expect(urlCards).toHaveLength(0);
  });
});
