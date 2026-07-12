// ── Sort dropdown ─────────────────────────────────────────────────────────────
// DOM wiring for the results header's "Sort" control. Shares its open/close/
// dismiss mechanics with the Show dropdown via dropdownPanel.ts, so both
// behave identically. Unlike Show, the trigger/footer label reflects the
// currently selected sort option's label.

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
import { SORT_OPTIONS, type SortOption } from './sortListings';

export const SORT_RADIO_ID_BY_OPTION: Record<SortOption, string> = {
  'source-url': 'sortSourceUrl',
  'best-match': 'sortBestMatch',
  'worst-match': 'sortWorstMatch',
  'lowest-price': 'sortLowestPrice',
  'highest-price': 'sortHighestPrice',
};

function sortOptionLabel(value: SortOption): string {
  const option = SORT_OPTIONS.find((sortOption) => sortOption.value === value);
  if (!option) throw new Error(`Unknown sort option: ${value}`);
  return option.label;
}

const SORT_DROPDOWN_IDS: DropdownShellIds = {
  root: 'sortDropdown',
  trigger: 'sortDropdownBtn',
  panel: 'sortDropdownPanel',
  options: 'sortDropdownOptions',
  footer: 'sortDropdownFooterBtn',
};

function getSortDropdownElements(): DropdownElements {
  return getDropdownElements(SORT_DROPDOWN_IDS);
}

// One-time init: builds the dropdown shell (trigger/panel/footer) into its
// mount point, then the panel's radio rows from SORT_OPTIONS, and seeds the
// trigger/footer label to the default option's label.
export function populateSortControls(defaultValue: SortOption): void {
  buildDropdownShell(SORT_DROPDOWN_IDS, 'Sort by');
  const optionsContainer = getElement(SORT_DROPDOWN_IDS.options);
  for (const { value, label } of SORT_OPTIONS) {
    const radioId = SORT_RADIO_ID_BY_OPTION[value];
    const row = document.createElement('label');
    row.className = 'dropdown-option-row';
    row.htmlFor = radioId;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'sortBy';
    radio.id = radioId;
    radio.value = value;
    radio.checked = value === defaultValue;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    row.append(radio, labelSpan);
    optionsContainer.appendChild(row);
  }
  setDropdownLabel(getSortDropdownElements(), sortOptionLabel(defaultValue));
}

// Sole writer of the radios' checked state and the trigger/footer label —
// derives both from the given value.
export function renderSortControls(sortBy: SortOption): void {
  for (const [value, radioId] of Object.entries(SORT_RADIO_ID_BY_OPTION) as Array<
    [SortOption, string]
  >) {
    getElement<HTMLInputElement>(radioId).checked = value === sortBy;
  }
  setDropdownLabel(getSortDropdownElements(), sortOptionLabel(sortBy));
}

export function toggleSortDropdownPanel(): void {
  toggleDropdownPanel(getSortDropdownElements());
}

export function closeSortDropdownPanel(): void {
  closeDropdownPanel(getSortDropdownElements());
}
