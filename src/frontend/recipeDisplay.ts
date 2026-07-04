import { RecipeId, type RecipeSource, requirePattern } from "../lib/recipes/metadata";
import { esc } from "./html";

const SOURCE_META: Record<RecipeId, { label: string; faviconUrl: string }> = {
  [RecipeId.Trademe]: {
    label: "Trade Me",
    faviconUrl: "https://www.google.com/s2/favicons?domain=trademe.co.nz&sz=16",
  },
  [RecipeId.Facebook]: {
    label: "Facebook",
    faviconUrl: "https://www.google.com/s2/favicons?domain=facebook.com&sz=16",
  },
};

export function recipeFaviconHtml(recipeId: RecipeId): string {
  const { label, faviconUrl } = SOURCE_META[recipeId];
  return `<img class="source-favicon" src="${esc(faviconUrl)}" alt="${esc(label)}" title="${esc(label)}" width="14" height="14">`;
}

export function sourceFaviconHtml(source: RecipeSource): string {
  return recipeFaviconHtml(requirePattern(source).recipeId);
}
