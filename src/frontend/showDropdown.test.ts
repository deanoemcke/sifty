// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyShowSelectSelection,
  closeShowDropdownPanel,
  populateShowControls,
  renderShowControls,
  setListingCategoryVisible,
  toggleShowDropdownPanel,
  updateShowSoldOptionVisibility,
} from './showDropdown';
import { resetState, visibleListingCategories } from './state';

function getShowSelect(): HTMLSelectElement {
  return document.getElementById('showNativeSelect') as HTMLSelectElement;
}

function getOptionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.value);
}

beforeEach(() => {
  resetState();
  document.body.innerHTML = `
    <input id="discoveryIncludeSoldItems" type="checkbox" />
    <div class="show-dropdown" id="showDropdown">
      <button id="showDropdownBtn" type="button" aria-expanded="false"></button>
      <select id="showNativeSelect" multiple aria-label="Show"></select>
      <div id="showDropdownPanel" class="hidden"></div>
    </div>
  `;
  populateShowControls();
});

describe('populateShowControls', () => {
  it('builds a checkbox row per category, all checked initially', () => {
    for (const id of ['showAvailable', 'showSold', 'showFiltered']) {
      const checkbox = document.getElementById(id) as HTMLInputElement;
      expect(checkbox.type).toBe('checkbox');
      expect(checkbox.checked).toBe(true);
    }
    expect(document.getElementById('showSoldRow')).not.toBeNull();
    const rowLabels = Array.from(document.querySelectorAll('#showDropdownPanel .checkbox-row')).map(
      (row) => row.textContent?.trim()
    );
    expect(rowLabels).toEqual(['Available', 'Sold', 'Filtered']);
  });

  it('builds a native option per category, all selected initially', () => {
    const select = getShowSelect();
    expect(getOptionValues(select)).toEqual(['available', 'sold', 'filtered']);
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Available',
      'Sold',
      'Filtered',
    ]);
    expect(Array.from(select.options).every((option) => option.selected)).toBe(true);
  });
});

describe('renderShowControls', () => {
  it('syncs checkbox checked state and option selected state from visibleListingCategories', () => {
    visibleListingCategories.delete('sold');
    renderShowControls();
    expect((document.getElementById('showAvailable') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('showSold') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('showFiltered') as HTMLInputElement).checked).toBe(true);
    const select = getShowSelect();
    expect(select.querySelector<HTMLOptionElement>('option[value="sold"]')?.selected).toBe(false);
    expect(select.querySelector<HTMLOptionElement>('option[value="available"]')?.selected).toBe(
      true
    );
    expect(select.querySelector<HTMLOptionElement>('option[value="filtered"]')?.selected).toBe(
      true
    );
  });
});

describe('applyShowSelectSelection', () => {
  it('updates visibleListingCategories from the selected options', () => {
    const select = getShowSelect();
    const soldOption = select.querySelector<HTMLOptionElement>('option[value="sold"]');
    if (!soldOption) throw new Error('sold option missing');
    soldOption.selected = false;
    applyShowSelectSelection(select);
    expect(visibleListingCategories.has('sold')).toBe(false);
    soldOption.selected = true;
    applyShowSelectSelection(select);
    expect(visibleListingCategories.has('sold')).toBe(true);
  });

  it('leaves categories without a present option untouched', () => {
    const select = getShowSelect();
    select.querySelector('option[value="sold"]')?.remove();
    const filteredOption = select.querySelector<HTMLOptionElement>('option[value="filtered"]');
    if (!filteredOption) throw new Error('filtered option missing');
    filteredOption.selected = false;
    applyShowSelectSelection(select);
    expect(visibleListingCategories.has('sold')).toBe(true);
    expect(visibleListingCategories.has('filtered')).toBe(false);
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
  it('hides the sold row and removes the sold option when include-sold-items is unchecked', () => {
    (document.getElementById('discoveryIncludeSoldItems') as HTMLInputElement).checked = false;
    updateShowSoldOptionVisibility();
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(true);
    expect(getOptionValues(getShowSelect())).toEqual(['available', 'filtered']);
    expect(visibleListingCategories.has('sold')).toBe(true);
  });

  it('shows the sold row and restores the sold option in order when include-sold-items is checked', () => {
    const includeSoldCheckbox = document.getElementById(
      'discoveryIncludeSoldItems'
    ) as HTMLInputElement;
    includeSoldCheckbox.checked = false;
    updateShowSoldOptionVisibility();
    includeSoldCheckbox.checked = true;
    updateShowSoldOptionVisibility();
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(false);
    expect(getOptionValues(getShowSelect())).toEqual(['available', 'sold', 'filtered']);
    expect(getShowSelect().querySelector<HTMLOptionElement>('option[value="sold"]')?.selected).toBe(
      true
    );
  });

  it('restores the sold option as unselected when sold is not in visibleListingCategories', () => {
    const includeSoldCheckbox = document.getElementById(
      'discoveryIncludeSoldItems'
    ) as HTMLInputElement;
    includeSoldCheckbox.checked = false;
    updateShowSoldOptionVisibility();
    visibleListingCategories.delete('sold');
    includeSoldCheckbox.checked = true;
    updateShowSoldOptionVisibility();
    expect(getShowSelect().querySelector<HTMLOptionElement>('option[value="sold"]')?.selected).toBe(
      false
    );
  });

  it('is idempotent when called repeatedly with the same state', () => {
    const includeSoldCheckbox = document.getElementById(
      'discoveryIncludeSoldItems'
    ) as HTMLInputElement;
    includeSoldCheckbox.checked = true;
    updateShowSoldOptionVisibility();
    updateShowSoldOptionVisibility();
    expect(getOptionValues(getShowSelect())).toEqual(['available', 'sold', 'filtered']);
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
