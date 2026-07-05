import { beforeEach, describe, expect, it } from "vitest";
import {
  aiFilterPendingRun,
  bulkDeepSearchUrls,
  canCancelSearch,
  isAiFilterRunning,
  isCardSearchActive,
  isSearchButtonDisabled,
  openModalListingUrl,
  resetState,
  setAiFilterPendingRun,
  setBulkDeepSearchUrls,
  setIsAiFilterRunning,
  setOpenModalListingUrl,
  setShowFilteredListings,
  showFilteredListings,
  singleDeepSearchInFlightUrls,
} from "./state";

describe("isSearchButtonDisabled", () => {
  it("returns false when idle and URL is fresh", () => {
    expect(isSearchButtonDisabled("idle", "", "https://trademe.co.nz/search")).toBe(false);
  });

  it("returns true when searching", () => {
    expect(isSearchButtonDisabled("searching", "", "https://trademe.co.nz/search")).toBe(true);
  });

  it("returns true when cancelling", () => {
    expect(isSearchButtonDisabled("cancelling", "", "https://trademe.co.nz/search")).toBe(true);
  });

  it("returns true when done and input matches previously searched URL", () => {
    const url = "https://trademe.co.nz/search";
    expect(isSearchButtonDisabled("done", url, url)).toBe(true);
  });

  it("returns false when done and input differs from previously searched URL", () => {
    expect(
      isSearchButtonDisabled("done", "https://trademe.co.nz/search", "https://trademe.co.nz/other"),
    ).toBe(false);
  });
});

describe("canCancelSearch", () => {
  it("returns true when searching", () => {
    expect(canCancelSearch("searching")).toBe(true);
  });

  it("returns false when idle", () => {
    expect(canCancelSearch("idle")).toBe(false);
  });

  it("returns false when cancellation already requested", () => {
    expect(canCancelSearch("cancelling")).toBe(false);
  });

  it("returns false when done", () => {
    expect(canCancelSearch("done")).toBe(false);
  });
});

describe("isAiFilterRunning / aiFilterPendingRun", () => {
  beforeEach(() => resetState());

  it("defaults to false", () => {
    expect(isAiFilterRunning).toBe(false);
    expect(aiFilterPendingRun).toBe(false);
  });

  it("setIsAiFilterRunning updates the flag", () => {
    setIsAiFilterRunning(true);
    expect(isAiFilterRunning).toBe(true);
    setIsAiFilterRunning(false);
    expect(isAiFilterRunning).toBe(false);
  });

  it("setAiFilterPendingRun updates the flag", () => {
    setAiFilterPendingRun(true);
    expect(aiFilterPendingRun).toBe(true);
    setAiFilterPendingRun(false);
    expect(aiFilterPendingRun).toBe(false);
  });

  it("resetState clears both flags", () => {
    setIsAiFilterRunning(true);
    setAiFilterPendingRun(true);
    resetState();
    expect(isAiFilterRunning).toBe(false);
    expect(aiFilterPendingRun).toBe(false);
  });
});

describe("openModalListingUrl", () => {
  beforeEach(() => resetState());

  it("defaults to null", () => {
    expect(openModalListingUrl).toBe(null);
  });

  it("setOpenModalListingUrl updates the value", () => {
    setOpenModalListingUrl("https://trademe.co.nz/listing/1");
    expect(openModalListingUrl).toBe("https://trademe.co.nz/listing/1");
    setOpenModalListingUrl(null);
    expect(openModalListingUrl).toBe(null);
  });

  it("resetState clears it back to null", () => {
    setOpenModalListingUrl("https://trademe.co.nz/listing/1");
    resetState();
    expect(openModalListingUrl).toBe(null);
  });
});

describe("showFilteredListings", () => {
  beforeEach(() => resetState());

  it("defaults to true", () => {
    expect(showFilteredListings).toBe(true);
  });

  it("setShowFilteredListings updates the value", () => {
    setShowFilteredListings(false);
    expect(showFilteredListings).toBe(false);
    setShowFilteredListings(true);
    expect(showFilteredListings).toBe(true);
  });

  it("resetState resets it back to true", () => {
    setShowFilteredListings(false);
    resetState();
    expect(showFilteredListings).toBe(true);
  });
});

describe("bulkDeepSearchUrls", () => {
  beforeEach(() => resetState());

  it("defaults to null", () => {
    expect(bulkDeepSearchUrls).toBe(null);
  });

  it("setBulkDeepSearchUrls updates the value", () => {
    const urls = new Set(["https://trademe.co.nz/listing/1"]);
    setBulkDeepSearchUrls(urls);
    expect(bulkDeepSearchUrls).toBe(urls);
    setBulkDeepSearchUrls(null);
    expect(bulkDeepSearchUrls).toBe(null);
  });

  it("resetState clears it back to null", () => {
    setBulkDeepSearchUrls(new Set(["https://trademe.co.nz/listing/1"]));
    resetState();
    expect(bulkDeepSearchUrls).toBe(null);
  });
});

describe("singleDeepSearchInFlightUrls", () => {
  beforeEach(() => resetState());

  it("starts empty", () => {
    expect(singleDeepSearchInFlightUrls.size).toBe(0);
  });

  it("resetState clears it", () => {
    singleDeepSearchInFlightUrls.add("https://trademe.co.nz/listing/1");
    resetState();
    expect(singleDeepSearchInFlightUrls.size).toBe(0);
  });
});

describe("isCardSearchActive", () => {
  it("returns true when searching", () => {
    expect(isCardSearchActive("searching")).toBe(true);
  });

  it("returns true when cancelling", () => {
    expect(isCardSearchActive("cancelling")).toBe(true);
  });

  it("returns false when idle", () => {
    expect(isCardSearchActive("idle")).toBe(false);
  });

  it("returns false when done", () => {
    expect(isCardSearchActive("done")).toBe(false);
  });
});
