// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { populateShowControls } from './showDropdown';
import { resetState } from './state';
import {
  createUrlCard,
  renderCardStatus,
  renderUrlRowMode,
  resetAllResults,
  resetCardForResearch,
} from './urlCardRow';
import { isUrlCardLive, readCardUrl, resetUrlCardStore, urlCardData } from './urlCardStore';

const TRADEME_URL = 'https://www.trademe.co.nz/search/test';
const TRADEME_URL_2 = 'https://www.trademe.co.nz/search/test?page=2';

function pressEnter(input: HTMLTextAreaElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
}

function blur(input: HTMLTextAreaElement): void {
  input.dispatchEvent(new FocusEvent('blur'));
}

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  document.body.innerHTML = `
    <div id="resultsSection" class="hidden"></div>
    <div id="urlCardsContainer"></div>
    <div id="listingsContainer"></div>
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

describe('createUrlCard — blur behaviour', () => {
  it('runs the search when a valid URL is present and the input is blurred', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));
    blur(card.dom.input);

    expect(searchCardAsync).toHaveBeenCalledExactlyOnceWith(card);
  });

  it('does not run the search on blur when the URL is invalid', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = 'not a url';
    card.dom.input.dispatchEvent(new Event('input'));
    blur(card.dom.input);

    expect(searchCardAsync).not.toHaveBeenCalled();
  });

  it('blocks the search and shows an error on blur when the URL duplicates another card', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card1 = createUrlCard(searchCardAsync);
    card1.dom.input.value = TRADEME_URL;
    card1.dom.input.dispatchEvent(new Event('input'));

    const card2 = createUrlCard(searchCardAsync);
    card2.dom.input.value = TRADEME_URL;
    card2.dom.input.dispatchEvent(new Event('input'));
    blur(card2.dom.input);

    expect(searchCardAsync).not.toHaveBeenCalled();
    expect(card2.dom.statusElement.textContent).toContain('This URL has already been added.');
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

  it('keeps the previous criteria and cache status visible when the edit button is clicked', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));
    const data = urlCardData(card);
    data.searchStatus = 'done';
    data.searchedUrl = TRADEME_URL;
    card.dom.input.readOnly = true;
    const criteriaGrid = card.dom.criteriaElement.querySelector('.criteria-grid');
    if (!criteriaGrid) throw new Error('missing .criteria-grid');
    criteriaGrid.innerHTML = '<div class="criteria-row">previous criteria</div>';
    card.dom.criteriaElement.classList.remove('hidden');
    card.dom.cacheStatusElement.innerHTML = 'Loaded from cache';
    card.dom.cacheStatusElement.classList.remove('hidden');
    renderCardStatus(card);

    card.dom.editButton.click();

    expect(card.dom.criteriaElement.classList.contains('hidden')).toBe(false);
    expect(criteriaGrid.innerHTML).toContain('previous criteria');
    expect(card.dom.cacheStatusElement.classList.contains('hidden')).toBe(false);
    expect(card.dom.cacheStatusElement.innerHTML).toBe('Loaded from cache');
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

  it('reverts to the link view on blur when the edited URL is left unchanged', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));
    const data = urlCardData(card);
    data.searchStatus = 'done';
    data.searchedUrl = TRADEME_URL;
    card.dom.input.readOnly = true;
    renderCardStatus(card);

    card.dom.editButton.click();
    blur(card.dom.input);

    expect(searchCardAsync).not.toHaveBeenCalled();
    expect(data.isEditing).toBe(false);
    expect(card.dom.input.readOnly).toBe(true);
    expect(card.dom.input.classList.contains('hidden')).toBe(true);
    expect(card.dom.linkElement.classList.contains('hidden')).toBe(false);
    expect(card.dom.editButton.classList.contains('hidden')).toBe(false);
  });

  it('reverts to the link view on Enter when the edited URL is left unchanged', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));
    const data = urlCardData(card);
    data.searchStatus = 'done';
    data.searchedUrl = TRADEME_URL;
    card.dom.input.readOnly = true;
    renderCardStatus(card);

    card.dom.editButton.click();
    pressEnter(card.dom.input);

    expect(searchCardAsync).not.toHaveBeenCalled();
    expect(data.isEditing).toBe(false);
    expect(card.dom.input.classList.contains('hidden')).toBe(true);
    expect(card.dom.linkElement.classList.contains('hidden')).toBe(false);
  });
});

describe('renderUrlRowMode — centralised isEditing/readOnly derivation', () => {
  it('derives readOnly from isEditing and searchedUrl instead of requiring callers to set it', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    const data = urlCardData(card);
    card.dom.input.value = TRADEME_URL;

    // Fresh, never-searched card: not editing, nothing searched yet.
    renderUrlRowMode(card);
    expect(card.dom.input.readOnly).toBe(false);

    // A completed search that isn't being edited is read-only.
    data.searchedUrl = TRADEME_URL;
    renderUrlRowMode(card);
    expect(card.dom.input.readOnly).toBe(true);

    // Flipping isEditing alone (no direct readOnly write) reopens the input.
    data.isEditing = true;
    renderUrlRowMode(card);
    expect(card.dom.input.readOnly).toBe(false);

    // Leaving edit mode alone restores read-only without any extra write.
    data.isEditing = false;
    renderUrlRowMode(card);
    expect(card.dom.input.readOnly).toBe(true);
  });

  it('resetAllResults clears a stale isEditing flag left over from an in-progress edit', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    const data = urlCardData(card);
    card.dom.input.value = TRADEME_URL;
    data.searchStatus = 'done';
    data.searchedUrl = TRADEME_URL;
    renderCardStatus(card);
    card.dom.editButton.click();
    expect(data.isEditing).toBe(true);

    resetAllResults();

    expect(data.isEditing).toBe(false);
    expect(card.dom.input.readOnly).toBe(false);
  });

  it('resetCardForResearch clears a stale isEditing flag left over from an in-progress edit', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    const data = urlCardData(card);
    card.dom.input.value = TRADEME_URL;
    data.searchStatus = 'done';
    data.searchedUrl = TRADEME_URL;
    renderCardStatus(card);
    card.dom.editButton.click();
    expect(data.isEditing).toBe(true);

    resetCardForResearch(card);

    expect(data.isEditing).toBe(false);
    expect(card.dom.input.readOnly).toBe(false);
  });
});

describe('createUrlCard — three-row input', () => {
  it('renders the URL field as a 3-row textarea', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));

    expect(card.dom.input.tagName).toBe('TEXTAREA');
    expect(card.dom.input.rows).toBe(3);
  });

  it('does not insert a newline when Enter triggers a search', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));

    pressEnter(card.dom.input);

    expect(card.dom.input.value).toBe(TRADEME_URL);
    expect(searchCardAsync).toHaveBeenCalledExactlyOnceWith(card);
  });
});

describe('createUrlCard — remove button vs. blur-triggered autosearch race', () => {
  it('prevents the default mousedown action, so clicking remove cannot blur the textarea and fire an autosearch first', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));

    const mousedownEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    card.dom.removeButton.dispatchEvent(mousedownEvent);

    expect(mousedownEvent.defaultPrevented).toBe(true);
  });

  it('removes the card from the live store when Remove is clicked', () => {
    // Second card only to keep the remove button visible/enabled — mirrors
    // updateRemoveButtons(), which hides it while a single card remains.
    createUrlCard(vi.fn().mockResolvedValue(undefined));
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));

    card.dom.removeButton.click();

    expect(isUrlCardLive(card)).toBe(false);
  });
});

describe('readCardUrl — embedded-newline normalization', () => {
  it('strips a newline from a pasted URL that wraps across the textarea rows', () => {
    const card = createUrlCard(vi.fn().mockResolvedValue(undefined));
    card.dom.input.value = `${TRADEME_URL}\n${TRADEME_URL_2.slice(TRADEME_URL.length)}`;

    expect(readCardUrl(card)).toBe(TRADEME_URL_2);
  });

  it('runs the search with the newline-stripped URL when a wrapped paste is blurred', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);
    card.dom.input.value = `${TRADEME_URL}\n${TRADEME_URL_2.slice(TRADEME_URL.length)}`;
    card.dom.input.dispatchEvent(new Event('input'));

    blur(card.dom.input);

    expect(searchCardAsync).toHaveBeenCalledExactlyOnceWith(card);
    expect(readCardUrl(card)).toBe(TRADEME_URL_2);
  });
});

describe('createUrlCard — invalid-URL rejection surfaces an error', () => {
  it('shows an error on blur when the pasted value is not a recognised search URL', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = 'not a url';
    card.dom.input.dispatchEvent(new Event('input'));
    blur(card.dom.input);

    expect(searchCardAsync).not.toHaveBeenCalled();
    expect(card.dom.statusElement.classList.contains('hidden')).toBe(false);
    expect(card.dom.statusElement.textContent).toContain('Not a recognised search URL.');
  });

  it('shows an error on Enter when the pasted value is not a recognised search URL', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = 'not a url';
    card.dom.input.dispatchEvent(new Event('input'));
    pressEnter(card.dom.input);

    expect(searchCardAsync).not.toHaveBeenCalled();
    expect(card.dom.statusElement.textContent).toContain('Not a recognised search URL.');
  });

  it('does not show an error when blurring a blank, untouched row', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    blur(card.dom.input);

    expect(searchCardAsync).not.toHaveBeenCalled();
    expect(card.dom.statusElement.classList.contains('hidden')).toBe(true);
  });

  it('clears the invalid-URL error once the input is edited again', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);
    card.dom.input.value = 'not a url';
    card.dom.input.dispatchEvent(new Event('input'));
    blur(card.dom.input);
    expect(card.dom.statusElement.textContent).toContain('Not a recognised search URL.');

    card.dom.input.value = 'still not a url but edited';
    card.dom.input.dispatchEvent(new Event('input'));

    expect(card.dom.statusElement.classList.contains('hidden')).toBe(true);
  });
});
