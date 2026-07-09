import { describe, expect, it } from 'vitest';
import { RecipeId } from '../lib/recipes/metadata';
import type { UrlCardSearchStatus } from './state';
import { computeUrlGroups, groupHeaderView, type UrlGroupMemberSnapshot } from './urlGroups';

const TRADEME_URL = 'https://www.trademe.co.nz/a/marketplace/search?q=x';
const FACEBOOK_URL = 'https://www.facebook.com/marketplace/wellington/search?query=x';

function member(overrides: Partial<UrlGroupMemberSnapshot> = {}): UrlGroupMemberSnapshot {
  return {
    url: TRADEME_URL,
    searchStatus: 'idle' as UrlCardSearchStatus,
    listingUrls: [],
    ...overrides,
  };
}

describe('computeUrlGroups', () => {
  it('groups members by recipe, ordered by recipe id, skipping unmatched urls', () => {
    const groups = computeUrlGroups([
      member({ url: FACEBOOK_URL }),
      member({ url: TRADEME_URL }),
      member({ url: 'not-a-url' }),
    ]);
    expect(groups.map((g) => g.recipeId)).toEqual([RecipeId.Trademe, RecipeId.Facebook]);
  });

  it("counts unique listings across the group's members", () => {
    const [group] = computeUrlGroups([
      member({ listingUrls: ['a', 'b'] }),
      member({ listingUrls: ['b', 'c'] }),
    ]);
    expect(group.uniqueListingsCount).toBe(3);
  });

  it('is cancellable while any member is searching', () => {
    const [group] = computeUrlGroups([
      member({ searchStatus: 'done' }),
      member({ searchStatus: 'searching' }),
    ]);
    expect(group.canCancel).toBe(true);
  });

  it('is not cancellable once members are cancelling or settled', () => {
    const [group] = computeUrlGroups([
      member({ searchStatus: 'cancelling' }),
      member({ searchStatus: 'done' }),
    ]);
    expect(group.canCancel).toBe(false);
  });

  it('stays busy while members are searching or cancelling', () => {
    expect(computeUrlGroups([member({ searchStatus: 'searching' })])[0].isBusy).toBe(true);
    expect(computeUrlGroups([member({ searchStatus: 'cancelling' })])[0].isBusy).toBe(true);
    expect(computeUrlGroups([member({ searchStatus: 'done' })])[0].isBusy).toBe(false);
  });
});

describe('groupHeaderView', () => {
  it('shows the count, spinner and cancel link while searches run', () => {
    expect(
      groupHeaderView({
        recipeId: RecipeId.Trademe,
        uniqueListingsCount: 12,
        canCancel: true,
        isBusy: true,
      })
    ).toEqual({ primaryText: '12 listings', showCancel: true, showSpinner: true });
  });

  it('hides the spinner and cancel link when nothing is running', () => {
    expect(
      groupHeaderView({
        recipeId: RecipeId.Trademe,
        uniqueListingsCount: 1,
        canCancel: false,
        isBusy: false,
      })
    ).toEqual({ primaryText: '1 listing', showCancel: false, showSpinner: false });
  });
});
