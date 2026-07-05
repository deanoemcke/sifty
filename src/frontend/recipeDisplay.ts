import { RecipeId, type RecipeSource, requirePattern } from "../lib/recipes/metadata";
import { esc } from "./html";

const SOURCE_META: Record<RecipeId, { label: string; faviconDomain: string }> = {
  [RecipeId.Trademe]: { label: "Trade Me", faviconDomain: "trademe.co.nz" },
  [RecipeId.Facebook]: { label: "Facebook", faviconDomain: "facebook.com" },
};

export function recipeFaviconHtml(recipeId: RecipeId, sizePx = 14): string {
  const { label, faviconDomain } = SOURCE_META[recipeId];
  // Fetch a larger source image once the display size outgrows the 16px icon.
  const sourceSize = sizePx <= 16 ? 16 : 64;
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${faviconDomain}&sz=${sourceSize}`;
  return `<img class="source-favicon" src="${esc(faviconUrl)}" alt="${esc(label)}" title="${esc(label)}" width="${sizePx}" height="${sizePx}">`;
}

export function sourceFaviconHtml(source: RecipeSource, sizePx = 14): string {
  return recipeFaviconHtml(requirePattern(source).recipeId, sizePx);
}
