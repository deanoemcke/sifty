// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOpenDropdown } from './dropdownPanel';
import {
  closeSortDropdownPanel,
  populateSortControls,
  renderSortControls,
  toggleSortDropdownPanel,
} from './sortDropdown';

beforeEach(() => {
  resetOpenDropdown();
  document.body.innerHTML = '<div id="sortDropdown"></div>';
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

  it('sets the trigger label to the default option\'s label and the footer label to "Sort by" it', () => {
    populateSortControls('source-url');
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('Source URL');
    expect(document.getElementById('sortDropdownFooterBtn')?.textContent).toBe(
      'Sort by Source URL'
    );
  });

  it('seeds the label for a non-default default value too', () => {
    populateSortControls('best-match');
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('Best match');
  });

  it('invokes onSortOptionChange with the selected option when a radio changes', () => {
    const onSortOptionChange = vi.fn();
    populateSortControls('source-url', onSortOptionChange);

    const bestMatchRadio = document.getElementById('sortBestMatch') as HTMLInputElement;
    bestMatchRadio.checked = true;
    bestMatchRadio.dispatchEvent(new Event('change'));

    expect(onSortOptionChange).toHaveBeenCalledTimes(1);
    expect(onSortOptionChange).toHaveBeenCalledWith('best-match');
  });

  it('does not throw when no callback is given and a radio changes', () => {
    populateSortControls('source-url');
    const bestMatchRadio = document.getElementById('sortBestMatch') as HTMLInputElement;
    bestMatchRadio.checked = true;
    expect(() => bestMatchRadio.dispatchEvent(new Event('change'))).not.toThrow();
  });
});

describe('renderSortControls', () => {
  it('checks only the matching radio', () => {
    populateSortControls('source-url');
    renderSortControls('lowest-price');
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('#sortDropdownOptions input[type="radio"]')
    );
    for (const radio of radios) {
      expect(radio.checked).toBe(radio.value === 'lowest-price');
    }
  });

  it('updates the trigger label to the newly selected option and the footer label to "Sort by" it', () => {
    populateSortControls('source-url');
    renderSortControls('highest-price');
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('Highest price');
    expect(document.getElementById('sortDropdownFooterBtn')?.textContent).toBe(
      'Sort by Highest price'
    );
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
