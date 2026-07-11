// ── Show dropdown ─────────────────────────────────────────────────────────────
// DOM wiring for the results header's "Show" control (Available/Sold/Filtered).
// Shares its open/close/dismiss mechanics with the Sort dropdown via
// dropdownPanel.ts, so both behave identically — a desktop anchored panel or
// (CSS breakpoint only) a mobile full-screen sheet. Deriving a listing's
// category and applying visibility to rendered cards is resultsView.ts's job
// (getListingCategory / applyClientFilters); this module only renders the
// control from state it's handed.

import { getElement } from './domUtils';
import {
  closeDropdownPanel,
  type DropdownElements,
  getDropdownElements,
  setDropdownLabel,
  toggleDropdownPanel,
} from './dropdownPanel';
import {
  getListingCategory,
  type ListingItem,
  type ListingVisibilityCategory,
  visibleListingCategories,
} from './state';

export const SHOW_OPTIONS: Array<{ value: ListingVisibilityCategory; label: string }> = [
  { value: 'available', label: 'Available' },
  { value: 'sold', label: 'Sold' },
  { value: 'filtered', label: 'Filtered' },
];

export const SHOW_CHECKBOX_ID_BY_CATEGORY: Record<ListingVisibilityCategory, string> = {
  available: 'showAvailable',
  sold: 'showSold',
  filtered: 'showFiltered',
};

const SHOW_DROPDOWN_IDS = {
  root: 'showDropdown',
  trigger: 'showDropdownBtn',
  panel: 'showDropdownPanel',
  footer: 'showDropdownFooterBtn',
};

function getShowDropdownElements(): DropdownElements {
  return getDropdownElements(SHOW_DROPDOWN_IDS);
}

// One-time init: builds the panel's checkbox rows (each with a count span)
// from SHOW_OPTIONS, and seeds the trigger/footer label.
export function populateShowControls(): void {
  const optionsContainer = getElement('showDropdownOptions');
  for (const { value, label } of SHOW_OPTIONS) {
    const checkboxId = SHOW_CHECKBOX_ID_BY_CATEGORY[value];
    const row = document.createElement('label');
    row.className = 'dropdown-option-row';
    row.id = `${checkboxId}Row`;
    row.htmlFor = checkboxId;
    const checkbox = document.createElement('input');
    checkbox.id = checkboxId;
    checkbox.type = 'checkbox';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    const countSpan = document.createElement('span');
    countSpan.className = 'dropdown-option-count';
    countSpan.id = `${checkboxId}Count`;
    row.append(checkbox, labelSpan, countSpan);
    optionsContainer.appendChild(row);
  }
  renderShowControls();
  renderShowOptions([], 0);
}

// Sole writer of the checkboxes' checked state — derives it from state.
export function renderShowControls(): void {
  for (const [category, checkboxId] of Object.entries(SHOW_CHECKBOX_ID_BY_CATEGORY) as Array<
    [ListingVisibilityCategory, string]
  >) {
    getElement<HTMLInputElement>(checkboxId).checked = visibleListingCategories.has(category);
  }
}

export function tallyListingCategories(
  listings: ListingItem[]
): Record<ListingVisibilityCategory, number> {
  const tally: Record<ListingVisibilityCategory, number> = { available: 0, sold: 0, filtered: 0 };
  for (const item of listings) tally[getListingCategory(item)]++;
  return tally;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// Sole writer of the per-category count spans and the trigger/footer label.
// Called from resultsView.ts's renderDerived() with the listings/visibleCount
// it already computed, so counts stay on a single update path.
export function renderShowOptions(listings: ListingItem[], visibleCount: number): void {
  const tally = tallyListingCategories(listings);
  for (const [category, checkboxId] of Object.entries(SHOW_CHECKBOX_ID_BY_CATEGORY) as Array<
    [ListingVisibilityCategory, string]
  >) {
    getElement(`${checkboxId}Count`).textContent = `(${tally[category]})`;
  }
  setDropdownLabel(getShowDropdownElements(), `Show ${pluralize(visibleCount, 'result')}`);
}

export function setListingCategoryVisible(
  category: ListingVisibilityCategory,
  isVisible: boolean
): void {
  if (isVisible) visibleListingCategories.add(category);
  else visibleListingCategories.delete(category);
}

// The "Sold" choice only makes sense when the search can return sold items at
// all, so it's hidden whenever the sidebar's "Include sold items" checkbox is
// unchecked. Never mutates visibleListingCategories.
export function updateShowSoldOptionVisibility(): void {
  const includeSoldItems = getElement<HTMLInputElement>('discoveryIncludeSoldItems').checked;
  getElement(`${SHOW_CHECKBOX_ID_BY_CATEGORY.sold}Row`).classList.toggle(
    'hidden',
    !includeSoldItems
  );
}

export function toggleShowDropdownPanel(): void {
  toggleDropdownPanel(getShowDropdownElements());
}

export function closeShowDropdownPanel(): void {
  closeDropdownPanel(getShowDropdownElements());
}
