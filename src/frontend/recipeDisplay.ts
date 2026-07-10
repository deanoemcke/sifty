import { RecipeId, type RecipeSource, requirePattern } from '../lib/recipes/metadata';
import { esc } from './html';

// brandColor is the dominant colour sampled from each favicon, used to tint
// the badge behind it on listing cards.
const SOURCE_META: Record<RecipeId, { label: string; faviconDomain: string; brandColor: string }> =
  {
    [RecipeId.Trademe]: {
      label: 'Trade Me',
      faviconDomain: 'trademe.co.nz',
      brandColor: '#feeb33',
    },
    [RecipeId.Facebook]: {
      label: 'Facebook',
      faviconDomain: 'facebook.com',
      brandColor: '#0866ff',
    },
    [RecipeId.TrademeExpired]: {
      label: 'Trade Me (sold)',
      faviconDomain: 'trademe.co.nz',
      brandColor: '#feeb33',
    },
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

export function sourceBadgeHtml(source: RecipeSource, sizePx: number): string {
  const { recipeId } = requirePattern(source);
  const { brandColor } = SOURCE_META[recipeId];
  return `<span class="listing-source-badge" style="background:${brandColor}">${recipeFaviconHtml(recipeId, sizePx)}</span>`;
}
