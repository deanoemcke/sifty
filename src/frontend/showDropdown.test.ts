// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeShowDropdownPanel,
  renderShowDropdownCheckboxes,
  setListingCategoryVisible,
  toggleShowDropdownPanel,
  updateShowSoldOptionVisibility,
} from './showDropdown';
import { resetState, visibleListingCategories } from './state';

beforeEach(() => {
  resetState();
  document.body.innerHTML = `
    <input id="discoveryIncludeSoldItems" type="checkbox" />
    <div class="show-dropdown" id="showDropdown">
      <button id="showDropdownBtn" type="button" aria-expanded="false"></button>
      <div id="showDropdownPanel" class="hidden">
        <label class="checkbox-row" id="showAvailableRow"><input id="showAvailable" type="checkbox" checked /></label>
        <label class="checkbox-row" id="showSoldRow"><input id="showSold" type="checkbox" checked /></label>
        <label class="checkbox-row" id="showFilteredRow"><input id="showFiltered" type="checkbox" checked /></label>
      </div>
    </div>
  `;
});

describe('renderShowDropdownCheckboxes', () => {
  it('syncs checkbox checked state from visibleListingCategories', () => {
    visibleListingCategories.delete('sold');
    renderShowDropdownCheckboxes();
    expect((document.getElementById('showAvailable') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('showSold') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('showFiltered') as HTMLInputElement).checked).toBe(true);
  });
});

describe('setListingCategoryVisible', () => {
  it('adds the category when visible', () => {
    visibleListingCategories.delete('sold');
    setListingCategoryVisible('sold', true);
    expect(visibleListingCategories.has('sold')).toBe(true);
  });

  it('removes the category when not visible', () => {
    setListingCategoryVisible('filtered', false);
    expect(visibleListingCategories.has('filtered')).toBe(false);
  });
});

describe('updateShowSoldOptionVisibility', () => {
  it('hides the sold row when include-sold-items is unchecked', () => {
    (document.getElementById('discoveryIncludeSoldItems') as HTMLInputElement).checked = false;
    updateShowSoldOptionVisibility();
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(true);
  });

  it('shows the sold row when include-sold-items is checked', () => {
    (document.getElementById('discoveryIncludeSoldItems') as HTMLInputElement).checked = true;
    document.getElementById('showSoldRow')?.classList.add('hidden');
    updateShowSoldOptionVisibility();
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(false);
  });
});

describe('toggleShowDropdownPanel / closeShowDropdownPanel', () => {
  it('opens a closed panel and sets aria-expanded true', () => {
    toggleShowDropdownPanel();
    expect(document.getElementById('showDropdownPanel')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('showDropdownBtn')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes an open panel and sets aria-expanded false', () => {
    toggleShowDropdownPanel();
    toggleShowDropdownPanel();
    expect(document.getElementById('showDropdownPanel')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('showDropdownBtn')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('closeShowDropdownPanel closes the panel and resets aria-expanded', () => {
    toggleShowDropdownPanel();
    closeShowDropdownPanel();
    expect(document.getElementById('showDropdownPanel')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('showDropdownBtn')?.getAttribute('aria-expanded')).toBe('false');
  });
});
