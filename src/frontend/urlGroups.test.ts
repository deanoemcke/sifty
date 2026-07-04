import { describe, expect, it } from "vitest";
import { RecipeId } from "../lib/recipes/metadata";
import type { UrlCardSearchStatus } from "./state";
import { computeUrlGroups, groupHeaderView, type UrlGroupMemberSnapshot } from "./urlGroups";

const TRADEME_URL = "https://www.trademe.co.nz/a/marketplace/search?q=x";
const FACEBOOK_URL = "https://www.facebook.com/marketplace/wellington/search?query=x";

function member(overrides: Partial<UrlGroupMemberSnapshot> = {}): UrlGroupMemberSnapshot {
  return {
    url: TRADEME_URL,
    searchStatus: "idle" as UrlCardSearchStatus,
    listingUrls: [],
    lastProgress: null,
    progressSeq: 0,
    errorMessage: null,
    wasCancelled: false,
    ...overrides,
  };
}

describe("computeUrlGroups", () => {
  it("groups members by recipe, ordered by recipe id, skipping unmatched urls", () => {
    const groups = computeUrlGroups([
      member({ url: FACEBOOK_URL }),
      member({ url: TRADEME_URL }),
      member({ url: "not-a-url" }),
    ]);
    expect(groups.map((g) => g.recipeId)).toEqual([RecipeId.Trademe, RecipeId.Facebook]);
  });

  it("counts unique listings across the group's members", () => {
    const [group] = computeUrlGroups([
      member({ listingUrls: ["a", "b"] }),
      member({ listingUrls: ["b", "c"] }),
    ]);
    expect(group.uniqueListingsCount).toBe(3);
  });

  it("is searching and cancellable while any member is searching", () => {
    const [group] = computeUrlGroups([
      member({ searchStatus: "done" }),
      member({ searchStatus: "searching" }),
    ]);
    expect(group.phase).toBe("searching");
    expect(group.canCancel).toBe(true);
  });

  it("is cancelling when any member is cancelling, even if others still search", () => {
    const [group] = computeUrlGroups([
      member({ searchStatus: "searching" }),
      member({ searchStatus: "cancelling" }),
    ]);
    expect(group.phase).toBe("cancelling");
  });

  it("surfaces the freshest progress among searching members", () => {
    const [group] = computeUrlGroups([
      member({
        searchStatus: "searching",
        progressSeq: 1,
        lastProgress: { phase: "paging", page: 1 },
      }),
      member({
        searchStatus: "searching",
        progressSeq: 7,
        lastProgress: { phase: "paging", page: 3, totalPages: 5 },
      }),
    ]);
    expect(group.detailProgress).toEqual({ phase: "paging", page: 3, totalPages: 5 });
  });

  it("reports failures and cancellations once all members settle", () => {
    const [group] = computeUrlGroups([
      member({ searchStatus: "done", errorMessage: "Failed to fetch" }),
      member({ searchStatus: "idle", wasCancelled: true, listingUrls: ["a"] }),
      member({ searchStatus: "done", listingUrls: ["b"] }),
    ]);
    expect(group.phase).toBe("done");
    expect(group.failedCount).toBe(1);
    expect(group.wasCancelled).toBe(true);
  });
});

describe("groupHeaderView", () => {
  const doneGroup = {
    recipeId: RecipeId.Trademe,
    uniqueListingsCount: 12,
    canCancel: false,
    phase: "done" as const,
    detailProgress: null,
    failedCount: 0,
    wasCancelled: false,
  };

  it("shows count with progress detail while searching", () => {
    const view = groupHeaderView({
      ...doneGroup,
      phase: "searching",
      canCancel: true,
      detailProgress: { phase: "paging", page: 2, totalPages: 5 },
    });
    expect(view).toEqual({
      showSpinner: true,
      primaryText: "12 listings…",
      detailText: "Fetching page 2/5…",
      problemText: null,
      showCancel: true,
    });
  });

  it("shows cancelling", () => {
    const view = groupHeaderView({ ...doneGroup, phase: "cancelling" });
    expect(view.primaryText).toBe("Cancelling…");
    expect(view.showSpinner).toBe(true);
    expect(view.showCancel).toBe(false);
  });

  it("shows the plain count when done cleanly", () => {
    expect(groupHeaderView(doneGroup)).toEqual({
      showSpinner: false,
      primaryText: "12 listings",
      detailText: null,
      problemText: null,
      showCancel: false,
    });
  });

  it("appends failure and cancellation suffixes when done", () => {
    const view = groupHeaderView({
      ...doneGroup,
      failedCount: 2,
      wasCancelled: true,
    });
    expect(view.problemText).toBe("2 failed · cancelled");
  });
});
