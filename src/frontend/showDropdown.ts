// ── Show dropdown ─────────────────────────────────────────────────────────────
// DOM wiring for the results header's "Show" control (Available/Sold/Filtered
// checkboxes). Owns the panel open/close and checkbox/state sync only —
// deriving a listing's category and applying visibility to rendered cards is
// resultsView.ts's job (getListingCategory / applyClientFilters).

import { getElement } from './domUtils';
import { type ListingVisibilityCategory, visibleListingCategories } from './state';

const SHOW_CHECKBOX_ID_BY_CATEGORY: Record<ListingVisibilityCategory, string> = {
  available: 'showAvailable',
  sold: 'showSold',
  filtered: 'showFiltered',
};

// Sole writer of the show-dropdown checkboxes' checked state — derives it from state.
export function renderShowDropdownCheckboxes(): void {
  for (const [category, id] of Object.entries(SHOW_CHECKBOX_ID_BY_CATEGORY) as Array<
    [ListingVisibilityCategory, string]
  >) {
    getElement<HTMLInputElement>(id).checked = visibleListingCategories.has(category);
  }
}

export function setListingCategoryVisible(
  category: ListingVisibilityCategory,
  isVisible: boolean
): void {
  if (isVisible) visibleListingCategories.add(category);
  else visibleListingCategories.delete(category);
}

// The "Sold" checkbox only makes sense when the search can return sold items
// at all, so it's hidden whenever the sidebar's "Include sold items" checkbox
// is unchecked.
export function updateShowSoldOptionVisibility(): void {
  const includeSoldItems = getElement<HTMLInputElement>('discoveryIncludeSoldItems').checked;
  getElement('showSoldRow').classList.toggle('hidden', !includeSoldItems);
}

export function toggleShowDropdownPanel(): void {
  const panel = getElement('showDropdownPanel');
  const isOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', isOpen);
  getElement<HTMLButtonElement>('showDropdownBtn').setAttribute('aria-expanded', String(!isOpen));
}

export function closeShowDropdownPanel(): void {
  getElement('showDropdownPanel').classList.add('hidden');
  getElement<HTMLButtonElement>('showDropdownBtn').setAttribute('aria-expanded', 'false');
}
