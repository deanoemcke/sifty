// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOpenDropdown } from './dropdownPanel';
import {
  closeShowDropdownPanel,
  populateShowControls,
  renderShowControls,
  renderShowOptions,
  tallyListingCategories,
  toggleShowDropdownPanel,
  updateShowSoldOptionVisibility,
} from './showDropdown';
import { resetState, setListingCategoryVisible, visibleListingCategories } from './state';
import { makeListingItem } from './testFixtures';

beforeEach(() => {
  resetState();
  resetOpenDropdown();
  // deepBtn / aiFilter / aiFilterBtn / listingsContainer are needed because
  // updateShowSoldOptionVisibility's reconciliation path calls
  // applyClientFilters(), whose renderDerived() touches them.
  document.body.innerHTML = `
    <input id="discoveryIncludeSoldItems" type="checkbox" />
    <button id="deepBtn"></button>
    <textarea id="aiFilter"></textarea>
    <button id="aiFilterBtn"></button>
    <div id="listingsContainer"></div>
    <div id="showDropdown"></div>
  `;
  populateShowControls();
});

describe('populateShowControls', () => {
  it('builds a checkbox row with a label and a count span per category', () => {
    for (const id of ['showAvailable', 'showSold', 'showFiltered']) {
      const checkbox = document.getElementById(id) as HTMLInputElement;
      expect(checkbox.type).toBe('checkbox');
      expect(checkbox.checked).toBe(true);
      expect(document.getElementById(`${id}Count`)).not.toBeNull();
    }
    const rowLabels = Array.from(document.querySelectorAll('#showDropdownOptions label')).map(
      (row) => row.querySelector('span:not(.dropdown-option-count)')?.textContent
    );
    expect(rowLabels).toEqual(['Available', 'Sold', 'Filtered']);
  });

  it('seeds the trigger and footer labels to "0 of 0 results"', () => {
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('0 of 0 results');
    expect(document.getElementById('showDropdownFooterBtn')?.textContent).toBe('0 of 0 results');
  });

  it('invokes onCategoryToggle with the category and checked state when a checkbox changes', () => {
    const onCategoryToggle = vi.fn();
    populateShowControls(onCategoryToggle);

    const soldCheckbox = document.getElementById('showSold') as HTMLInputElement;
    soldCheckbox.checked = false;
    soldCheckbox.dispatchEvent(new Event('change'));

    expect(onCategoryToggle).toHaveBeenCalledTimes(1);
    expect(onCategoryToggle).toHaveBeenCalledWith('sold', false);
  });

  it('does not throw when no callback is given and a checkbox changes', () => {
    const availableCheckbox = document.getElementById('showAvailable') as HTMLInputElement;
    expect(() => availableCheckbox.dispatchEvent(new Event('change'))).not.toThrow();
  });
});

describe('renderShowControls', () => {
  it('syncs checkbox checked state from visibleListingCategories', () => {
    setListingCategoryVisible('sold', false);
    renderShowControls();
    expect((document.getElementById('showAvailable') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('showSold') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('showFiltered') as HTMLInputElement).checked).toBe(true);
  });
});

describe('tallyListingCategories', () => {
  it('tallies listings per category', () => {
    const listings = [
      makeListingItem(),
      makeListingItem({ data: { ...makeListingItem().data, isSold: true } }),
      makeListingItem({ data: { ...makeListingItem().data, isSold: true } }),
      makeListingItem({ aiFilterReason: 'too expensive' }),
    ];
    expect(tallyListingCategories(listings)).toEqual({ available: 1, sold: 2, filtered: 1 });
  });

  it('returns all zeros for an empty array', () => {
    expect(tallyListingCategories([])).toEqual({ available: 0, sold: 0, filtered: 0 });
  });
});

describe('renderShowOptions', () => {
  it('writes per-category counts and a "visible of total results" trigger/footer label', () => {
    const listings = [
      makeListingItem(),
      makeListingItem({ data: { ...makeListingItem().data, isSold: true } }),
      makeListingItem({ aiFilterReason: 'too expensive' }),
    ];
    renderShowOptions(listings, 2);
    for (const [category, count] of [
      ['showAvailable', 1],
      ['showSold', 1],
      ['showFiltered', 1],
    ] as const) {
      expect(document.getElementById(`${category}Count`)?.textContent).toBe(`(${count})`);
    }
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('2 of 3 results');
    expect(document.getElementById('showDropdownFooterBtn')?.textContent).toBe('2 of 3 results');
  });

  it('does not pluralize — "results" is always literal, matching the old header phrasing', () => {
    renderShowOptions([], 0);
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('0 of 0 results');
  });
});

describe('updateShowSoldOptionVisibility', () => {
  it('hides the sold row when include-sold-items is unchecked', () => {
    (document.getElementById('discoveryIncludeSoldItems') as HTMLInputElement).checked = false;
    updateShowSoldOptionVisibility();
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(true);
  });

  it('re-adds sold to visibleListingCategories and re-checks the checkbox when hiding the row', () => {
    // A hidden control must not keep filtering: unticking Show > Sold and then
    // hiding the row would otherwise leave sold listings excluded with no
    // visible control to restore them.
    setListingCategoryVisible('sold', false);
    renderShowControls();
    (document.getElementById('discoveryIncludeSoldItems') as HTMLInputElement).checked = false;

    updateShowSoldOptionVisibility();

    expect(visibleListingCategories.has('sold')).toBe(true);
    expect((document.getElementById('showSold') as HTMLInputElement).checked).toBe(true);
  });

  it('preserves an unticked Sold state while the row stays visible', () => {
    setListingCategoryVisible('sold', false);
    renderShowControls();
    (document.getElementById('discoveryIncludeSoldItems') as HTMLInputElement).checked = true;

    updateShowSoldOptionVisibility();

    expect(visibleListingCategories.has('sold')).toBe(false);
    expect((document.getElementById('showSold') as HTMLInputElement).checked).toBe(false);
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
