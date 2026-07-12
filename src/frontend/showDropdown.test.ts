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
} from './showDropdown';
import { resetState, setListingCategoryVisible, visibleListingCategories } from './state';
import { makeListingItem } from './testFixtures';

beforeEach(() => {
  resetState();
  resetOpenDropdown();
  document.body.innerHTML = `
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

  it('seeds the trigger label to "0 of 0 results" and the footer label to "Show 0 of 0 results"', () => {
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('0 of 0 results');
    expect(document.getElementById('showDropdownFooterBtn')?.textContent).toBe(
      'Show 0 of 0 results'
    );
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
  it('writes per-category counts, a bare trigger label, and a "Show" footer label', () => {
    const listings = [
      makeListingItem(),
      makeListingItem({ data: { ...makeListingItem().data, isSold: true } }),
      makeListingItem({ aiFilterReason: 'too expensive' }),
    ];
    setListingCategoryVisible('filtered', false);
    renderShowOptions(listings);
    for (const [category, count] of [
      ['showAvailable', 1],
      ['showSold', 1],
      ['showFiltered', 1],
    ] as const) {
      expect(document.getElementById(`${category}Count`)?.textContent).toBe(`(${count})`);
    }
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('2 of 3 results');
    expect(document.getElementById('showDropdownFooterBtn')?.textContent).toBe(
      'Show 2 of 3 results'
    );
  });

  it('does not pluralize — "results" is always literal, matching the old header phrasing', () => {
    renderShowOptions([]);
    expect(document.querySelector('.dropdown-trigger-label')?.textContent).toBe('0 of 0 results');
  });

  // The Sold row is gated on whether the current results contain any sold
  // listings, not on the sidebar's "Include sold items" checkbox — a hidden
  // row can then never strand an active 'sold' exclusion, since there is
  // nothing sold on screen to strand.
  it('hides the Sold row when the current results contain no sold listings', () => {
    renderShowOptions([makeListingItem()]);
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(true);
  });

  it('shows the Sold row when the current results contain a sold listing', () => {
    const soldItem = makeListingItem({ data: { ...makeListingItem().data, isSold: true } });
    renderShowOptions([soldItem]);
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(false);
  });

  it('re-hides the Sold row on a later render whose results have no sold listings', () => {
    const soldItem = makeListingItem({ data: { ...makeListingItem().data, isSold: true } });
    renderShowOptions([soldItem]);
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(false);

    renderShowOptions([makeListingItem()]);
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(true);
  });

  it('leaves an unticked Sold preference untouched by row visibility changes', () => {
    setListingCategoryVisible('sold', false);
    renderShowControls();

    renderShowOptions([makeListingItem()]);
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(true);
    expect(visibleListingCategories.has('sold')).toBe(false);

    const soldItem = makeListingItem({ data: { ...makeListingItem().data, isSold: true } });
    renderShowOptions([soldItem]);
    expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(false);
    expect(visibleListingCategories.has('sold')).toBe(false);
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
