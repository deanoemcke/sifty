// Browser-safe — no Node/Playwright imports.
import { RECIPE_PATTERNS, type RecipeId } from './metadata';

function matchRecipePattern(url: string): (typeof RECIPE_PATTERNS)[number] | null {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      RECIPE_PATTERNS.find(
        (p) =>
          (hostname === p.hostname || hostname.endsWith(`.${p.hostname}`)) &&
          pathname.includes(p.pathPrefix)
      ) ?? null
    );
  } catch {
    return null;
  }
}

export function isValidRecipeUrl(url: string): boolean {
  return matchRecipePattern(url) !== null;
}

export function recipeIdForUrl(url: string): RecipeId | null {
  return matchRecipePattern(url)?.recipeId ?? null;
}

// The canonical group a URL's recipe belongs to for display purposes (URL group
// cards, sort-by-source) — distinct from recipeIdForUrl, which returns the true
// matched recipe and still distinguishes e.g. trademe from trademe-expired.
export function recipeGroupIdForUrl(url: string): RecipeId | null {
  return matchRecipePattern(url)?.groupId ?? null;
}
