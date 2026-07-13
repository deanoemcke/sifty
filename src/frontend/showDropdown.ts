// ── Show dropdown ─────────────────────────────────────────────────────────────
// DOM wiring for the results header's "Show" control (Used/Sold/New/Filtered).
// Shares its open/close/dismiss mechanics with the Sort dropdown via
// dropdownPanel.ts, so both behave identically — a desktop anchored panel or
// (CSS breakpoint only) a mobile full-screen sheet. Deriving a listing's
// category and applying visibility to rendered cards is resultsView.ts's job
// (getListingCategory / applyClientFilters); this module only renders the
// control from state it's handed.

import { getElement } from './domUtils';
import {
  buildDropdownShell,
  closeDropdownPanel,
  type DropdownElements,
  type DropdownShellIds,
  getDropdownElements,
  setDropdownLabel,
  toggleDropdownPanel,
} from './dropdownPanel';
import {
  ALL_LISTING_VISIBILITY_CATEGORIES,
  getListingCategory,
  type ListingItem,
  type ListingVisibilityCategory,
  visibleListingCategories,
} from './state';

export const SHOW_OPTIONS: Array<{ value: ListingVisibilityCategory; label: string }> = [
  { value: 'used', label: 'Used' },
  { value: 'sold', label: 'Sold' },
  { value: 'new', label: 'New' },
  { value: 'filtered', label: 'Filtered' },
];

const SHOW_CHECKBOX_ID_BY_CATEGORY: Record<ListingVisibilityCategory, string> = {
  used: 'showUsed',
  sold: 'showSold',
  new: 'showNew',
  filtered: 'showFiltered',
};

const SHOW_DROPDOWN_IDS: DropdownShellIds = {
  root: 'showDropdown',
  trigger: 'showDropdownBtn',
  panel: 'showDropdownPanel',
  options: 'showDropdownOptions',
  footer: 'showDropdownFooterBtn',
};

function getShowDropdownElements(): DropdownElements {
  return getDropdownElements(SHOW_DROPDOWN_IDS);
}

// One-time init: builds the dropdown shell (trigger/panel/footer) into its
// mount point, then the panel's checkbox rows (each with a count span) from
// SHOW_OPTIONS, and seeds the trigger/footer label. Wires each checkbox's
// `change` event to onCategoryToggle so callers never need to know the
// per-category checkbox ids — those stay private to this module.
export function populateShowControls(
  onCategoryToggle: (category: ListingVisibilityCategory, isVisible: boolean) => void = () => {}
): void {
  buildDropdownShell(SHOW_DROPDOWN_IDS, 'Show');
  const optionsContainer = getElement(SHOW_DROPDOWN_IDS.options);
  for (const { value, label } of SHOW_OPTIONS) {
    const checkboxId = SHOW_CHECKBOX_ID_BY_CATEGORY[value];
    const row = document.createElement('label');
    row.className = 'dropdown-option-row';
    row.id = `${checkboxId}Row`;
    row.htmlFor = checkboxId;
    const checkbox = document.createElement('input');
    checkbox.id = checkboxId;
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => onCategoryToggle(value, checkbox.checked));
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    const countSpan = document.createElement('span');
    countSpan.className = 'dropdown-option-count';
    countSpan.id = `${checkboxId}Count`;
    row.append(checkbox, labelSpan, countSpan);
    optionsContainer.appendChild(row);
  }
  renderShowControls();
  renderShowOptions([]);
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
  const tally: Record<ListingVisibilityCategory, number> = {
    used: 0,
    sold: 0,
    new: 0,
    filtered: 0,
  };
  for (const item of listings) tally[getListingCategory(item)]++;
  return tally;
}

// Sole writer of the per-category count spans and the trigger/footer label.
// Called from resultsView.ts's renderDerived() with the listings it already
// computed; visibleCount is derived here from the same tally rather than
// being passed in, so there is a single computation of it. The label format
// and literal "results" (never pluralized) match the header's former
// "Showing N / X results" line, which this control now replaces.
//
// The "Sold" row is gated on whether the current results actually contain any
// sold listings (tally.sold), rather than on the sidebar's "Include sold
// items" checkbox: gating on the checkbox let a hidden row keep governing
// 'sold' exclusion for listings already on screen, with no visible control to
// restore them (see PR #32 review). Gating on the tally instead means the row
// can only ever hide when there is nothing sold to strand, so no
// visibleListingCategories reconciliation is needed here — the checkbox's own
// checked state (and its effect on already-rendered cards) is left untouched
// by row visibility, and simply reflects whichever way the user last set it
// next time the row reappears.
export function renderShowOptions(listings: ListingItem[]): void {
  const tally = tallyListingCategories(listings);
  const visibleCount = ALL_LISTING_VISIBILITY_CATEGORIES.filter((category) =>
    visibleListingCategories.has(category)
  ).reduce((sum, category) => sum + tally[category], 0);
  for (const [category, checkboxId] of Object.entries(SHOW_CHECKBOX_ID_BY_CATEGORY) as Array<
    [ListingVisibilityCategory, string]
  >) {
    getElement(`${checkboxId}Count`).textContent = `(${tally[category]})`;
  }
  getElement(`${SHOW_CHECKBOX_ID_BY_CATEGORY.sold}Row`).classList.toggle(
    'hidden',
    tally.sold === 0
  );
  getElement(`${SHOW_CHECKBOX_ID_BY_CATEGORY.new}Row`).classList.toggle('hidden', tally.new === 0);
  setDropdownLabel(
    getShowDropdownElements(),
    `${visibleCount} of ${listings.length} results`,
    `Show ${visibleCount} of ${listings.length} results`
  );
}

export function toggleShowDropdownPanel(): void {
  toggleDropdownPanel(getShowDropdownElements());
}

export function closeShowDropdownPanel(): void {
  closeDropdownPanel(getShowDropdownElements());
}
