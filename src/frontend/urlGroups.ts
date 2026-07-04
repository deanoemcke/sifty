// Recipe grouping for source URL rows — pure logic, no DOM access.
// The group header shows only the deduped live listing count plus a cancel
// link while any member search is running; per-URL detail lives on the rows.

import { recipeIdForUrl } from "../lib/recipes/matcher";
import type { RecipeId } from "../lib/recipes/metadata";
import { listingsCountText } from "./searchStatusText";
import { canCancelSearch, type UrlCardSearchStatus } from "./state";

export interface UrlGroupMemberSnapshot {
  url: string;
  searchStatus: UrlCardSearchStatus;
  listingUrls: readonly string[];
}

export interface UrlGroupSummary {
  recipeId: RecipeId;
  uniqueListingsCount: number;
  canCancel: boolean;
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
    .map(([recipeId, groupMembers]) => ({
      recipeId,
      uniqueListingsCount: new Set(groupMembers.flatMap((m) => m.listingUrls)).size,
      canCancel: groupMembers.some((m) => canCancelSearch(m.searchStatus)),
    }));
}

export interface UrlGroupHeaderView {
  primaryText: string;
  showCancel: boolean;
}

export function groupHeaderView(summary: UrlGroupSummary): UrlGroupHeaderView {
  return {
    primaryText: listingsCountText(summary.uniqueListingsCount),
    showCancel: summary.canCancel,
  };
}
