// ── Sort dropdown ─────────────────────────────────────────────────────────────
// DOM wiring for the results header's "Sort" control. Shares its open/close/
// dismiss mechanics with the Show dropdown via dropdownPanel.ts, so both
// behave identically. Unlike Show, the trigger/footer label is always the
// static "Sort results" — the selected option isn't reflected in the label.

import { getElement } from './domUtils';
import {
  closeDropdownPanel,
  type DropdownElements,
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

const SORT_TRIGGER_LABEL = 'Sort results';

const SORT_DROPDOWN_IDS = {
  root: 'sortDropdown',
  trigger: 'sortDropdownBtn',
  panel: 'sortDropdownPanel',
  footer: 'sortDropdownFooterBtn',
};

function getSortDropdownElements(): DropdownElements {
  return getDropdownElements(SORT_DROPDOWN_IDS);
}

// One-time init: builds the panel's radio rows from SORT_OPTIONS and seeds
// the static trigger/footer label.
export function populateSortControls(defaultValue: SortOption): void {
  const optionsContainer = getElement('sortDropdownOptions');
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
  setDropdownLabel(getSortDropdownElements(), SORT_TRIGGER_LABEL);
}

// Sole writer of the radios' checked state — derives it from the given value.
export function renderSortControls(sortBy: SortOption): void {
  for (const [value, radioId] of Object.entries(SORT_RADIO_ID_BY_OPTION) as Array<
    [SortOption, string]
  >) {
    getElement<HTMLInputElement>(radioId).checked = value === sortBy;
  }
}

export function toggleSortDropdownPanel(): void {
  toggleDropdownPanel(getSortDropdownElements());
}

export function closeSortDropdownPanel(): void {
  closeDropdownPanel(getSortDropdownElements());
}
