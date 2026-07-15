// Browser-safe — no Node/Playwright imports.
// Single source of truth for which URLs each recipe handles.
// Update this list (and RecipeId) when adding a new recipe.

// Stable numeric identifier per recipe; display metadata (e.g. favicons) is
// keyed by this enum rather than the recipe's name string.
export enum RecipeId {
  Trademe = 1,
  Facebook = 2,
  TrademeExpired = 3,
}

export const RECIPE_PATTERNS = [
  // trademe-expired must precede trademe: both share a hostname, matchRecipePattern
  // takes the first match, and trademe's pathPrefix is '' (matches any path on the
  // hostname) — so the more specific legacy pattern needs first refusal.
  //
  // groupId canonicalizes trademe-expired onto the same id as trademe: they're
  // presented as a single source (one URL group card, grouped together when
  // sorting by source) even though they remain distinct recipes so listings can
  // still show a "sold" vs active badge via their own recipeId.
  {
    name: 'trademe-expired',
    recipeId: RecipeId.TrademeExpired,
    groupId: RecipeId.Trademe,
    hostname: 'trademe.co.nz',
    pathPrefix: '/Browse/SearchResults.aspx',
  },
  {
    name: 'trademe',
    recipeId: RecipeId.Trademe,
    groupId: RecipeId.Trademe,
    hostname: 'trademe.co.nz',
    pathPrefix: '',
  },
  {
    name: 'facebook',
    recipeId: RecipeId.Facebook,
    groupId: RecipeId.Facebook,
    hostname: 'facebook.com',
    pathPrefix: '/marketplace/',
  },
] as const;

export type RecipeSource = (typeof RECIPE_PATTERNS)[number]['name'];

// Single source of truth for human-readable source names — shared by the
// frontend's source badge and server-side notification text.
export const RECIPE_LABELS: Record<RecipeId, string> = {
  [RecipeId.Trademe]: 'Trade Me',
  [RecipeId.Facebook]: 'Facebook',
  [RecipeId.TrademeExpired]: 'Trade Me (sold)',
};

export function requirePattern(name: RecipeSource) {
  const pattern = RECIPE_PATTERNS.find((p) => p.name === name);
  if (!pattern) throw new Error(`Recipe pattern "${name}" not found`);
  return pattern;
}
