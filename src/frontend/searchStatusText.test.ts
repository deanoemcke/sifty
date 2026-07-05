import { describe, expect, it } from "vitest";
import {
  cardStatusText,
  listingsCountText,
  parseQuickSearchProgress,
  progressText,
} from "./searchStatusText";

describe("progressText", () => {
  it("describes the loading phase", () => {
    expect(progressText({ phase: "loading" })).toBe("Loading…");
  });

  it("describes the counted phase with pluralisation", () => {
    expect(progressText({ phase: "counted", totalResults: 43, totalPages: 2 })).toBe(
      "43 results across 2 pages",
    );
    expect(progressText({ phase: "counted", totalResults: 1, totalPages: 1 })).toBe(
      "1 result across 1 page",
    );
  });

  it("describes paging with and without a known page total", () => {
    expect(progressText({ phase: "paging", page: 1 })).toBe("Fetching page 1…");
    expect(progressText({ phase: "paging", page: 2, totalPages: 5 })).toBe("Fetching page 2/5…");
  });

  it("describes collecting with the loading-more variant", () => {
    expect(progressText({ phase: "collecting", foundSoFar: 8, isLoadingMore: false })).toBe(
      "Found 8 listings…",
    );
    expect(progressText({ phase: "collecting", foundSoFar: 8, isLoadingMore: true })).toBe(
      "Found 8 listings, loading more…",
    );
  });
});

describe("listingsCountText", () => {
  it("pluralises listing counts", () => {
    expect(listingsCountText(0)).toBe("0 listings");
    expect(listingsCountText(1)).toBe("1 listing");
    expect(listingsCountText(7)).toBe("7 listings");
  });
});

describe("parseQuickSearchProgress", () => {
  it("accepts each well-formed phase", () => {
    expect(parseQuickSearchProgress({ phase: "loading" })).toEqual({ phase: "loading" });
    expect(parseQuickSearchProgress({ phase: "counted", totalResults: 3, totalPages: 1 })).toEqual({
      phase: "counted",
      totalResults: 3,
      totalPages: 1,
    });
    expect(parseQuickSearchProgress({ phase: "paging", page: 2, totalPages: 5 })).toEqual({
      phase: "paging",
      page: 2,
      totalPages: 5,
    });
    expect(parseQuickSearchProgress({ phase: "collecting", foundSoFar: 4 })).toEqual({
      phase: "collecting",
      foundSoFar: 4,
      isLoadingMore: false,
    });
  });

  it("rejects unknown phases and malformed payloads", () => {
    expect(parseQuickSearchProgress({ phase: "warp" })).toBe(null);
    expect(parseQuickSearchProgress({ phase: "counted", totalResults: "3" })).toBe(null);
    expect(parseQuickSearchProgress({ phase: "paging" })).toBe(null);
    expect(parseQuickSearchProgress({})).toBe(null);
  });
});

describe("cardStatusText", () => {
  const base = {
    searchStatus: "idle" as const,
    lastProgress: null,
    listingsFoundCount: 0,
    errorMessage: null,
    wasCancelled: false,
  };

  it("returns null for an idle card", () => {
    expect(cardStatusText(base)).toBe(null);
  });

  it("shows a generic fetching message when searching without progress yet", () => {
    expect(cardStatusText({ ...base, searchStatus: "searching" })).toEqual({
      text: "Fetching listings…",
      kind: "info",
    });
  });

  it("shows the latest progress while searching", () => {
    expect(
      cardStatusText({
        ...base,
        searchStatus: "searching",
        lastProgress: { phase: "paging", page: 2, totalPages: 5 },
      }),
    ).toEqual({ text: "Fetching page 2/5…", kind: "info" });
  });

  it("shows cancelling state", () => {
    expect(cardStatusText({ ...base, searchStatus: "cancelling" })).toEqual({
      text: "Cancelling…",
      kind: "info",
    });
  });

  it("shows the listings count when done", () => {
    expect(cardStatusText({ ...base, searchStatus: "done", listingsFoundCount: 5 })).toEqual({
      text: "5 listings",
      kind: "success",
    });
  });

  it("shows the error when the search failed", () => {
    expect(
      cardStatusText({ ...base, searchStatus: "done", errorMessage: "Failed to fetch" }),
    ).toEqual({ text: "Failed to fetch", kind: "error" });
  });

  it("shows the cancelled summary after a cancelled search", () => {
    expect(cardStatusText({ ...base, wasCancelled: true, listingsFoundCount: 3 })).toEqual({
      text: "Cancelled — 3 listings",
      kind: "error",
    });
  });
});
