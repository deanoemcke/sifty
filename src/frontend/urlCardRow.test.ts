// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { populateShowControls } from './showDropdown';
import { resetState } from './state';
import { createUrlCard, renderCardStatus } from './urlCardRow';
import { resetUrlCardStore, urlCardData } from './urlCardStore';

const TRADEME_URL = 'https://www.trademe.co.nz/search/test';
const TRADEME_URL_2 = 'https://www.trademe.co.nz/search/test?page=2';

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}

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

describe('createUrlCard — paste behaviour', () => {
  it('does not run the search when a valid URL is pasted into the input', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('paste'));
    card.dom.input.dispatchEvent(new Event('input'));

    expect(searchCardAsync).not.toHaveBeenCalled();
    expect(card.dom.input.classList.contains('hidden')).toBe(false);
  });

  it('runs the search when Enter is pressed after pasting a valid URL', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('paste'));
    card.dom.input.dispatchEvent(new Event('input'));
    pressEnter(card.dom.input);

    expect(searchCardAsync).toHaveBeenCalledExactlyOnceWith(card);
  });

  it('runs the search when Enter is pressed after typing character-by-character', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));
    pressEnter(card.dom.input);

    expect(searchCardAsync).toHaveBeenCalledExactlyOnceWith(card);
  });

  it('does not run the search when Enter is pressed with an invalid URL', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = 'not a url';
    card.dom.input.dispatchEvent(new Event('input'));
    pressEnter(card.dom.input);

    expect(searchCardAsync).not.toHaveBeenCalled();
  });
});

describe('createUrlCard — duplicate URL detection', () => {
  it('blocks the search and shows an error when the URL duplicates another card', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card1 = createUrlCard(searchCardAsync);
    card1.dom.input.value = TRADEME_URL;
    card1.dom.input.dispatchEvent(new Event('input'));

    const card2 = createUrlCard(searchCardAsync);
    card2.dom.input.value = TRADEME_URL;
    card2.dom.input.dispatchEvent(new Event('input'));
    pressEnter(card2.dom.input);

    expect(searchCardAsync).not.toHaveBeenCalled();
    expect(card2.dom.statusElement.classList.contains('hidden')).toBe(false);
    expect(card2.dom.statusElement.textContent).toContain('This URL has already been added.');
  });

  it('clears the duplicate error once the input is edited', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card1 = createUrlCard(searchCardAsync);
    card1.dom.input.value = TRADEME_URL;
    card1.dom.input.dispatchEvent(new Event('input'));

    const card2 = createUrlCard(searchCardAsync);
    card2.dom.input.value = TRADEME_URL;
    card2.dom.input.dispatchEvent(new Event('input'));
    pressEnter(card2.dom.input);

    card2.dom.input.value = TRADEME_URL_2;
    card2.dom.input.dispatchEvent(new Event('input'));

    expect(card2.dom.statusElement.classList.contains('hidden')).toBe(true);
  });

  it('runs the search when the URL differs from other cards', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card1 = createUrlCard(searchCardAsync);
    card1.dom.input.value = TRADEME_URL;
    card1.dom.input.dispatchEvent(new Event('input'));

    const card2 = createUrlCard(searchCardAsync);
    card2.dom.input.value = TRADEME_URL_2;
    card2.dom.input.dispatchEvent(new Event('input'));
    pressEnter(card2.dom.input);

    expect(searchCardAsync).toHaveBeenCalledExactlyOnceWith(card2);
  });
});

describe('createUrlCard — edit button', () => {
  it('is shown, with the input and search button hidden, once a card is done', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));
    const data = urlCardData(card);
    data.searchStatus = 'done';
    data.searchedUrl = TRADEME_URL;
    renderCardStatus(card);

    expect(card.dom.editButton.classList.contains('hidden')).toBe(false);
    expect(card.dom.input.classList.contains('hidden')).toBe(true);
    expect(card.dom.searchButton.classList.contains('hidden')).toBe(true);
  });

  it('stays hidden while a search is actively running', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));
    const data = urlCardData(card);
    data.searchStatus = 'searching';
    renderCardStatus(card);

    expect(card.dom.editButton.classList.contains('hidden')).toBe(true);
  });

  it('reveals an editable, focused input pre-filled with the previous URL when clicked', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));
    const data = urlCardData(card);
    data.searchStatus = 'done';
    data.searchedUrl = TRADEME_URL;
    card.dom.input.readOnly = true;
    renderCardStatus(card);

    card.dom.editButton.click();

    expect(card.dom.input.classList.contains('hidden')).toBe(false);
    expect(card.dom.input.readOnly).toBe(false);
    expect(card.dom.input.value).toBe(TRADEME_URL);
    expect(card.dom.editButton.classList.contains('hidden')).toBe(true);
  });

  it('runs a new search after editing the URL and pressing Enter', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));
    const data = urlCardData(card);
    data.searchStatus = 'done';
    data.searchedUrl = TRADEME_URL;
    renderCardStatus(card);

    card.dom.editButton.click();
    card.dom.input.value = TRADEME_URL_2;
    card.dom.input.dispatchEvent(new Event('input'));
    pressEnter(card.dom.input);

    expect(searchCardAsync).toHaveBeenCalledExactlyOnceWith(card);
  });
});
