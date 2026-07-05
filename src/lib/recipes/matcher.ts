// Browser-safe — no Node/Playwright imports.
import { RECIPE_PATTERNS, type RecipeId } from "./metadata";

function matchRecipePattern(url: string): (typeof RECIPE_PATTERNS)[number] | null {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      RECIPE_PATTERNS.find(
        (p) =>
          (hostname === p.hostname || hostname.endsWith(`.${p.hostname}`)) &&
          pathname.includes(p.pathPrefix),
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
