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
import { SORT_DROPDOWN_FIXTURE_HTML } from './testFixtures';

beforeEach(() => {
  resetOpenDropdown();
  document.body.innerHTML = SORT_DROPDOWN_FIXTURE_HTML;
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

  it("sets the trigger and footer label to the default option's label", () => {
    populateSortControls('source-url');
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('Source URL');
    expect(document.getElementById('sortDropdownFooterBtn')?.textContent).toBe('Source URL');
  });

  it('seeds the label for a non-default default value too', () => {
    populateSortControls('best-match');
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('Best match');
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

  it('updates the trigger and footer label to the newly selected option', () => {
    populateSortControls('source-url');
    renderSortControls('highest-price');
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('Highest price');
    expect(document.getElementById('sortDropdownFooterBtn')?.textContent).toBe('Highest price');
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
