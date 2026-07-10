// Server-side only — imports Node/Playwright recipes.
import type { Recipe } from '../../lib/recipes/base';
import { facebookRecipe } from './facebook';
import { trademeRecipe } from './trademe';
import { trademeExpiredRecipe } from './trademeExpired';

// trademeExpiredRecipe must precede trademeRecipe: both share a hostname, getRecipeForUrl
// takes the first match, and trademeRecipe.matches() checks hostname only — so the more
// specific legacy-URL recipe needs first refusal (mirrors RECIPE_PATTERNS ordering in
// src/lib/recipes/metadata.ts).
const recipes: Recipe[] = [trademeExpiredRecipe, trademeRecipe, facebookRecipe];

export function getRecipeForUrl(url: string): Recipe | null {
  return recipes.find((r) => r.matches(url)) ?? null;
}

export function getAllRecipes(): readonly Recipe[] {
  return recipes;
}
