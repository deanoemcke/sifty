// ── Show dropdown ─────────────────────────────────────────────────────────────
// DOM wiring for the results header's "Show" control (Available/Sold/Filtered).
// The control is hybrid: a custom button-and-checkbox popover on fine-pointer
// devices, and a transparent native <select multiple> overlaid on the button on
// coarse-pointer devices (see .show-native-select in styles.css). Both are
// populated from SHOW_OPTIONS and derive their checked/selected state from
// visibleListingCategories. Deriving a listing's category and applying
// visibility to rendered cards is resultsView.ts's job
// (getListingCategory / applyClientFilters).

import { getElement } from './domUtils';
import { type ListingVisibilityCategory, visibleListingCategories } from './state';

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

// One-time init: builds the popover's checkbox rows and the native select's
// options from SHOW_OPTIONS.
export function populateShowControls(): void {
  const panel = getElement('showDropdownPanel');
  const select = getElement<HTMLSelectElement>('showNativeSelect');
  for (const { value, label } of SHOW_OPTIONS) {
    const checkboxId = SHOW_CHECKBOX_ID_BY_CATEGORY[value];
    const row = document.createElement('label');
    row.className = 'checkbox-row';
    row.id = `${checkboxId}Row`;
    row.htmlFor = checkboxId;
    const checkbox = document.createElement('input');
    checkbox.id = checkboxId;
    checkbox.type = 'checkbox';
    row.append(checkbox, ` ${label}`);
    panel.appendChild(row);

    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  renderShowControls();
}

// Sole writer of the checkboxes' checked state and the select options'
// selected state — derives both from state. Structure-preserving: never
// creates or removes nodes, so it's safe to call while a native picker is
// open. Option add/remove happens only in updateShowSoldOptionVisibility.
export function renderShowControls(): void {
  const select = getElement<HTMLSelectElement>('showNativeSelect');
  for (const [category, checkboxId] of Object.entries(SHOW_CHECKBOX_ID_BY_CATEGORY) as Array<
    [ListingVisibilityCategory, string]
  >) {
    const isVisible = visibleListingCategories.has(category);
    getElement<HTMLInputElement>(checkboxId).checked = isVisible;
    const option = select.querySelector<HTMLOptionElement>(`option[value="${category}"]`);
    if (option) option.selected = isVisible;
  }
}

// Applies the native select's selection to state. Only categories with an
// option present are touched, so a category whose option is removed (sold,
// when include-sold is off) keeps its Set membership.
export function applyShowSelectSelection(select: HTMLSelectElement): void {
  for (const option of Array.from(select.options)) {
    setListingCategoryVisible(option.value as ListingVisibilityCategory, option.selected);
  }
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
// unchecked. The popover row is CSS-hidden, but the native option must be
// removed outright — native pickers don't reliably honour CSS on <option>.
// Neither path mutates visibleListingCategories.
export function updateShowSoldOptionVisibility(): void {
  const includeSoldItems = getElement<HTMLInputElement>('discoveryIncludeSoldItems').checked;
  getElement('showSoldRow').classList.toggle('hidden', !includeSoldItems);

  const select = getElement<HTMLSelectElement>('showNativeSelect');
  const soldOption = select.querySelector<HTMLOptionElement>('option[value="sold"]');
  if (!includeSoldItems) {
    soldOption?.remove();
  } else if (!soldOption) {
    const restoredOption = document.createElement('option');
    restoredOption.value = 'sold';
    restoredOption.textContent =
      SHOW_OPTIONS.find((showOption) => showOption.value === 'sold')?.label ?? 'Sold';
    restoredOption.selected = visibleListingCategories.has('sold');
    select.insertBefore(restoredOption, select.querySelector('option[value="filtered"]'));
  }
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
