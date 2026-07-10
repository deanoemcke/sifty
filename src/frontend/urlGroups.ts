// Recipe grouping for source URL rows — pure logic, no DOM access.
// The group header shows only the deduped live listing count plus a cancel
// link while any member search is running; per-URL detail lives on the rows.

import { recipeGroupIdForUrl } from '../lib/recipes/matcher';
import type { RecipeId } from '../lib/recipes/metadata';
import { listingsCountText } from './searchStatusText';
import { canCancelSearch, isCardSearchActive, type UrlCardSearchStatus } from './state';

export interface UrlGroupMemberSnapshot {
  url: string;
  searchStatus: UrlCardSearchStatus;
  listingUrls: readonly string[];
}

export interface UrlGroupSummary {
  groupId: RecipeId;
  uniqueListingsCount: number;
  canCancel: boolean;
  // True while any member search is still running or cancelling.
  isBusy: boolean;
}

export function computeUrlGroups(members: readonly UrlGroupMemberSnapshot[]): UrlGroupSummary[] {
  const membersByGroupId = new Map<RecipeId, UrlGroupMemberSnapshot[]>();
  for (const member of members) {
    const groupId = recipeGroupIdForUrl(member.url);
    if (groupId === null) continue;
    const bucket = membersByGroupId.get(groupId);
    if (bucket) bucket.push(member);
    else membersByGroupId.set(groupId, [member]);
  }
  return [...membersByGroupId.entries()]
    .sort(([groupIdA], [groupIdB]) => groupIdA - groupIdB)
    .map(([groupId, groupMembers]) => ({
      groupId,
      uniqueListingsCount: new Set(groupMembers.flatMap((m) => m.listingUrls)).size,
      canCancel: groupMembers.some((m) => canCancelSearch(m.searchStatus)),
      isBusy: groupMembers.some((m) => isCardSearchActive(m.searchStatus)),
    }));
}

export interface UrlGroupHeaderView {
  primaryText: string;
  showCancel: boolean;
  showSpinner: boolean;
}

export function groupHeaderView(summary: UrlGroupSummary): UrlGroupHeaderView {
  return {
    primaryText: listingsCountText(summary.uniqueListingsCount),
    showCancel: summary.canCancel,
    showSpinner: summary.isBusy,
  };
}
