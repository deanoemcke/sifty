// Server-side only — imports Node/Playwright recipes.
import type { Recipe } from './base';
import { trademeRecipe } from './trademe';

const recipes: Recipe[] = [trademeRecipe];

export function getRecipeForUrl(url: string): Recipe | null {
  return recipes.find(r => r.matches(url)) ?? null;
}
