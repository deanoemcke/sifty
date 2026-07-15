// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecipeId } from '../lib/recipes/metadata';
import { populateShowControls } from './showDropdown';
import { resetState } from './state';
import { createUrlCard } from './urlCardRow';
import { resetUrlCardStore } from './urlCardStore';
import { expandUrlGroup } from './urlGroupsView';

const TRADEME_URL_1 = 'https://www.trademe.co.nz/a/marketplace/search?q=x';
const TRADEME_URL_2_PREFIX = 'https://www.trademe.co.nz/a/marketplace/search?q=';

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  document.body.innerHTML = `
    <div id="resultsSection" class="hidden"></div>
    <div id="urlCardsContainer"></div>
    <button id="deepBtn"></button>
    <textarea id="aiFilter"></textarea>
    <button id="aiFilterBtn"></button>
    <div id="showDropdown"></div>
  `;
  populateShowControls();
});

describe('syncUrlGroups — focus retention while typing', () => {
  it('keeps an already-grouped card input focused while its URL is edited character by character', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card1 = createUrlCard(searchCardAsync);
    card1.dom.input.value = TRADEME_URL_1;
    card1.dom.input.dispatchEvent(new Event('input'));

    // Give card2 a URL that already matches the group up front, so it joins
    // the (already-created) group before we start observing focus — the
    // ungrouped-to-grouped transition is a legitimate move, not the bug
    // under test here.
    const card2 = createUrlCard(searchCardAsync);
    card2.dom.input.value = `${TRADEME_URL_2_PREFIX}a`;
    card2.dom.input.dispatchEvent(new Event('input'));
    expandUrlGroup(RecipeId.Trademe);

    card2.dom.input.focus();
    expect(document.activeElement).toBe(card2.dom.input);

    const typedSuffix = 'yyyyyyy';
    let typed = 'a';
    for (const char of typedSuffix) {
      typed += char;
      card2.dom.input.value = TRADEME_URL_2_PREFIX + typed;
      card2.dom.input.dispatchEvent(new Event('input'));
      expect(document.activeElement).toBe(card2.dom.input);
    }
  });
});
