// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState } from './state';
import { createUrlCard } from './urlCardRow';
import { resetUrlCardStore } from './urlCardStore';

const TRADEME_URL = 'https://www.trademe.co.nz/search/test';

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  document.body.innerHTML = `<div id="urlCardsContainer"></div>`;
});

describe('createUrlCard — paste auto-run', () => {
  it('runs the search when a valid URL is pasted into the input', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('paste'));
    card.dom.input.dispatchEvent(new Event('input'));

    expect(searchCardAsync).toHaveBeenCalledExactlyOnceWith(card);
  });

  it('does not run the search when typing a valid URL character-by-character (no paste)', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('input'));

    expect(searchCardAsync).not.toHaveBeenCalled();
  });

  it('does not run the search when the pasted text is not a valid recipe URL', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = 'not a url';
    card.dom.input.dispatchEvent(new Event('paste'));
    card.dom.input.dispatchEvent(new Event('input'));

    expect(searchCardAsync).not.toHaveBeenCalled();
  });

  it('only auto-runs once per paste — a follow-up edit does not re-trigger it', () => {
    const searchCardAsync = vi.fn().mockResolvedValue(undefined);
    const card = createUrlCard(searchCardAsync);

    card.dom.input.value = TRADEME_URL;
    card.dom.input.dispatchEvent(new Event('paste'));
    card.dom.input.dispatchEvent(new Event('input'));
    card.dom.input.value = `${TRADEME_URL}2`;
    card.dom.input.dispatchEvent(new Event('input'));

    expect(searchCardAsync).toHaveBeenCalledOnce();
  });
});
