// Recipe grouping for source URL rows — pure logic, no DOM access.
// The group header combines its members' semantic search state: any member
// cancelling wins, then any searching, then done; counts dedupe listing URLs
// across members.

import type { QuickSearchProgress } from "../lib/recipes/base";
import { recipeIdForUrl } from "../lib/recipes/matcher";
import type { RecipeId } from "../lib/recipes/metadata";
import { listingsCountText, progressText } from "./searchStatusText";
import { canCancelSearch, type UrlCardSearchStatus } from "./state";

export interface UrlGroupMemberSnapshot {
  url: string;
  searchStatus: UrlCardSearchStatus;
  listingUrls: readonly string[];
  lastProgress: QuickSearchProgress | null;
  progressSeq: number;
  errorMessage: string | null;
  wasCancelled: boolean;
}

export type UrlGroupPhase = "idle" | "searching" | "cancelling" | "done";

export interface UrlGroupSummary {
  recipeId: RecipeId;
  uniqueListingsCount: number;
  canCancel: boolean;
  phase: UrlGroupPhase;
  detailProgress: QuickSearchProgress | null;
  failedCount: number;
  wasCancelled: boolean;
}

function summariseGroup(
  recipeId: RecipeId,
  members: readonly UrlGroupMemberSnapshot[],
): UrlGroupSummary {
  const anyCancelling = members.some((m) => m.searchStatus === "cancelling");
  const anySearching = members.some((m) => m.searchStatus === "searching");
  const anySettled = members.some((m) => m.searchStatus === "done" || m.wasCancelled);
  const phase: UrlGroupPhase = anyCancelling
    ? "cancelling"
    : anySearching
      ? "searching"
      : anySettled
        ? "done"
        : "idle";
  const freshest = members.reduce<UrlGroupMemberSnapshot | null>(
    (best, m) =>
      m.searchStatus === "searching" &&
      m.lastProgress !== null &&
      (best === null || m.progressSeq > best.progressSeq)
        ? m
        : best,
    null,
  );
  return {
    recipeId,
    uniqueListingsCount: new Set(members.flatMap((m) => m.listingUrls)).size,
    canCancel: members.some((m) => canCancelSearch(m.searchStatus)),
    phase,
    detailProgress: freshest?.lastProgress ?? null,
    failedCount: members.filter((m) => m.errorMessage !== null).length,
    wasCancelled: members.some((m) => m.wasCancelled),
  };
}

export function computeUrlGroups(members: readonly UrlGroupMemberSnapshot[]): UrlGroupSummary[] {
  const membersByRecipeId = new Map<RecipeId, UrlGroupMemberSnapshot[]>();
  for (const member of members) {
    const recipeId = recipeIdForUrl(member.url);
    if (recipeId === null) continue;
    const bucket = membersByRecipeId.get(recipeId);
    if (bucket) bucket.push(member);
    else membersByRecipeId.set(recipeId, [member]);
  }
  return [...membersByRecipeId.entries()]
    .sort(([recipeIdA], [recipeIdB]) => recipeIdA - recipeIdB)
    .map(([recipeId, groupMembers]) => summariseGroup(recipeId, groupMembers));
}

export interface UrlGroupHeaderView {
  showSpinner: boolean;
  primaryText: string;
  detailText: string | null;
  problemText: string | null;
  showCancel: boolean;
}

export function groupHeaderView(summary: UrlGroupSummary): UrlGroupHeaderView {
  if (summary.phase === "cancelling")
    return {
      showSpinner: true,
      primaryText: "Cancelling…",
      detailText: null,
      problemText: null,
      showCancel: false,
    };
  if (summary.phase === "searching")
    return {
      showSpinner: true,
      primaryText: `${listingsCountText(summary.uniqueListingsCount)}…`,
      detailText: summary.detailProgress ? progressText(summary.detailProgress) : null,
      problemText: null,
      showCancel: summary.canCancel,
    };
  const problems = [
    ...(summary.failedCount > 0 ? [`${summary.failedCount} failed`] : []),
    ...(summary.wasCancelled ? ["cancelled"] : []),
  ];
  return {
    showSpinner: false,
    primaryText: listingsCountText(summary.uniqueListingsCount),
    detailText: null,
    problemText: problems.length > 0 ? problems.join(" · ") : null,
    showCancel: false,
  };
}
