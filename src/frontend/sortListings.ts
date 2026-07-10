// ── Result sorting ────────────────────────────────────────────────────────────
// Pure sort logic for the results grid — no DOM access except populateSortSelect,
// which only builds <option> elements.

import { requirePattern } from '../lib/recipes/metadata';
import type { ListingItem } from './state';

export type SortOption =
  | 'source-url'
  | 'best-match'
  | 'worst-match'
  | 'lowest-price'
  | 'highest-price';

export const DEFAULT_SORT_OPTION: SortOption = 'source-url';

export const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: 'source-url', label: 'Source URL' },
  { value: 'best-match', label: 'Best match' },
  { value: 'worst-match', label: 'Worst match' },
  { value: 'lowest-price', label: 'Lowest price' },
  { value: 'highest-price', label: 'Highest price' },
];

// Prices are compared with null always sorting last, regardless of direction —
// "Price on request" listings aren't comparable to a real price.
function comparePrice(a: number | null, b: number | null, ascending: boolean): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return ascending ? a - b : b - a;
}

export function sortListings(listings: ListingItem[], sortBy: SortOption): ListingItem[] {
  const sorted = [...listings];
  if (sortBy === 'source-url') {
    // Stable sort by canonical source group, so e.g. trademe and
    // trademe-expired listings end up adjacent instead of interleaved,
    // while listings within the same group keep their relative order.
    sorted.sort(
      (a, b) => requirePattern(a.data.source).groupId - requirePattern(b.data.source).groupId
    );
  } else if (sortBy === 'best-match') {
    sorted.sort((a, b) => b.data.relevance - a.data.relevance);
  } else if (sortBy === 'worst-match') {
    sorted.sort((a, b) => a.data.relevance - b.data.relevance);
  } else if (sortBy === 'lowest-price') {
    sorted.sort((a, b) => comparePrice(a.data.price, b.data.price, true));
  } else if (sortBy === 'highest-price') {
    sorted.sort((a, b) => comparePrice(a.data.price, b.data.price, false));
  }
  return sorted;
}

export function populateSortSelect(
  select: HTMLSelectElement,
  options: Array<{ value: SortOption; label: string }>,
  defaultValue: SortOption
): void {
  for (const option of options) {
    const optionElement = select.ownerDocument.createElement('option');
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    optionElement.selected = option.value === defaultValue;
    select.appendChild(optionElement);
  }
}
