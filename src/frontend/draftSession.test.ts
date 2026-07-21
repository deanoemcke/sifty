// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDraftSession,
  loadDraftSession,
  saveDraftSession,
  scheduleDraftSessionSave,
} from './draftSession';
import { resetState, setCurrentSearchId } from './state';
import { createUrlCard } from './urlCardRow';
import { resetUrlCardStore, urlCards } from './urlCardStore';

const DRAFT_SESSION_STORAGE_KEY = 'sifty:draftSession';

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  localStorage.clear();
  document.body.innerHTML = `
    <textarea id="discoveryPrompt"></textarea>
    <input id="discoveryMaxPrice" />
    <input id="discoveryAllowShipping" type="checkbox" />
    <input id="discoveryIncludeSoldItems" type="checkbox" />
    <input id="discoveryIncludeNewItems" type="checkbox" />
    <select id="discoveryRegion"><option value="">Any</option></select>
    <button id="discoveryBtn"></button>
    <div id="urlCardsContainer"></div>
    <textarea id="aiFilter"></textarea>
  `;
});

describe('saveDraftSession / loadDraftSession', () => {
  it('round-trips the current url cards, discover inputs, and AI filter text', () => {
    createUrlCard(async () => {});
    urlCards[0].dom.input.value = 'https://trademe.co.nz/a';
    (document.getElementById('discoveryPrompt') as HTMLTextAreaElement).value = 'lamp';
    (document.getElementById('aiFilter') as HTMLTextAreaElement).value = 'no cracks';

    saveDraftSession();
    const draft = loadDraftSession();

    expect(draft).toEqual({
      urls: ['https://trademe.co.nz/a'],
      discoverInputs: {
        prompt: 'lamp',
        maxPrice: undefined,
        fulfillment: 'pickup',
        includeSoldItems: false,
        includeNewItems: false,
        region: undefined,
      },
      aiFilter: 'no cracks',
    });
  });

  it('returns null when nothing has been saved', () => {
    expect(loadDraftSession()).toBe(null);
  });

  it('returns null for malformed JSON', () => {
    localStorage.setItem(DRAFT_SESSION_STORAGE_KEY, '{not json');
    expect(loadDraftSession()).toBe(null);
  });

  it('returns null when the stored shape is missing required fields', () => {
    localStorage.setItem(DRAFT_SESSION_STORAGE_KEY, JSON.stringify({ urls: ['x'] }));
    expect(loadDraftSession()).toBe(null);
  });

  it('does not persist a draft while a saved search is currently loaded', () => {
    createUrlCard(async () => {});
    setCurrentSearchId('abc123');

    saveDraftSession();

    expect(loadDraftSession()).toBe(null);
  });
});

describe('clearDraftSession', () => {
  it('removes any stored draft', () => {
    createUrlCard(async () => {});
    saveDraftSession();

    clearDraftSession();

    expect(loadDraftSession()).toBe(null);
  });
});

describe('scheduleDraftSessionSave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst of calls into a single debounced save', () => {
    createUrlCard(async () => {});
    urlCards[0].dom.input.value = 'https://trademe.co.nz/a';

    scheduleDraftSessionSave();
    scheduleDraftSessionSave();
    scheduleDraftSessionSave();
    expect(loadDraftSession()).toBe(null);

    vi.runAllTimers();

    expect(loadDraftSession()).not.toBe(null);
  });
});
