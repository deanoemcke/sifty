// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { resetOpenDropdown } from './dropdownPanel';
import {
  closeSortDropdownPanel,
  populateSortControls,
  renderSortControls,
  SORT_RADIO_ID_BY_OPTION,
  toggleSortDropdownPanel,
} from './sortDropdown';

beforeEach(() => {
  resetOpenDropdown();
  document.body.innerHTML = `
    <div class="dropdown-control" id="sortDropdown">
      <button id="sortDropdownBtn" type="button" aria-expanded="false">
        <span class="dropdown-trigger-label">Sort</span>
        <svg class="dropdown-caret"></svg>
      </button>
      <div id="sortDropdownPanel" class="hidden">
        <div id="sortDropdownOptions"></div>
        <button id="sortDropdownFooterBtn" type="button">Sort</button>
      </div>
    </div>
  `;
});

describe('populateSortControls', () => {
  it('builds a radio row per sort option, sharing one radio group name', () => {
    populateSortControls('best-match');
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('#sortDropdownOptions input[type="radio"]')
    );
    expect(radios).toHaveLength(5);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    const checkedValues = radios.filter((radio) => radio.checked).map((radio) => radio.value);
    expect(checkedValues).toEqual(['best-match']);
  });

  it('sets a static "Sort results" trigger and footer label', () => {
    populateSortControls('source-url');
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('Sort results');
    expect(document.getElementById('sortDropdownFooterBtn')?.textContent).toBe('Sort results');
  });
});

describe('renderSortControls', () => {
  it('checks only the matching radio', () => {
    populateSortControls('source-url');
    renderSortControls('lowest-price');
    for (const [value, radioId] of Object.entries(SORT_RADIO_ID_BY_OPTION)) {
      const radio = document.getElementById(radioId) as HTMLInputElement;
      expect(radio.checked).toBe(value === 'lowest-price');
    }
  });

  it('label stays static "Sort results" regardless of selection', () => {
    populateSortControls('source-url');
    renderSortControls('highest-price');
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('Sort results');
  });
});

describe('toggleSortDropdownPanel / closeSortDropdownPanel', () => {
  it('opens a closed panel and sets aria-expanded true', () => {
    populateSortControls('source-url');
    toggleSortDropdownPanel();
    expect(document.getElementById('sortDropdownPanel')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('sortDropdownBtn')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('closeSortDropdownPanel closes the panel and resets aria-expanded', () => {
    populateSortControls('source-url');
    toggleSortDropdownPanel();
    closeSortDropdownPanel();
    expect(document.getElementById('sortDropdownPanel')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('sortDropdownBtn')?.getAttribute('aria-expanded')).toBe('false');
  });
});
