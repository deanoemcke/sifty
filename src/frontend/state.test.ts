import { describe, expect, it, beforeEach } from "vitest";
import {
  canCancelSearch,
  isCardSearchActive,
  isSearchButtonDisabled,
  isAiFilterRunning,
  aiFilterPendingRun,
  setIsAiFilterRunning,
  setAiFilterPendingRun,
  resetState,
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
