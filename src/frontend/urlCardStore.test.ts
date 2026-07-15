import { beforeEach, describe, expect, it } from 'vitest';
import { resetState, type UrlCardData, urlCardDataById } from './state';
import {
  addUrlCard,
  removeUrlCardEntry,
  resetUrlCardStore,
  type UrlCard,
  type UrlCardDom,
  urlCardData,
  urlCards,
} from './urlCardStore';

function makeCardData(searchedUrl: string): UrlCardData {
  return {
    searchStatus: 'idle',
    searchedUrl,
    searchId: null,
    listingUrls: [],
    lastProgress: null,
    errorMessage: null,
    wasCancelled: false,
    isEditing: false,
  };
}

// The store pairs serialisable data with live DOM handles; tests only exercise
// the pairing invariant, so a stub handle is sufficient.
const stubDom = {} as UrlCardDom;

beforeEach(() => {
  resetState();
  resetUrlCardStore();
});

describe('addUrlCard', () => {
  it('joins each card to its own data by id', () => {
    const first = addUrlCard(stubDom, makeCardData('https://example.com/1'));
    const second = addUrlCard(stubDom, makeCardData('https://example.com/2'));
    expect(urlCards).toHaveLength(2);
    expect(urlCardDataById.size).toBe(2);
    expect(urlCardData(first).searchedUrl).toBe('https://example.com/1');
    expect(urlCardData(second).searchedUrl).toBe('https://example.com/2');
  });
});

describe('removeUrlCardEntry', () => {
  it("removes only the given card's own data, leaving others untouched", () => {
    const first = addUrlCard(stubDom, makeCardData('https://example.com/1'));
    const second = addUrlCard(stubDom, makeCardData('https://example.com/2'));
    const third = addUrlCard(stubDom, makeCardData('https://example.com/3'));

    removeUrlCardEntry(second);

    expect(urlCards).toEqual([first, third]);
    expect(urlCardDataById.has(second.id)).toBe(false);
    expect(urlCardData(first).searchedUrl).toBe('https://example.com/1');
    expect(urlCardData(third).searchedUrl).toBe('https://example.com/3');
  });

  it('leaves the store untouched for an unknown card', () => {
    const known = addUrlCard(stubDom, makeCardData('https://example.com/1'));
    const ghost: UrlCard = { id: 'ghost', dom: stubDom };
    removeUrlCardEntry(ghost);
    expect(urlCards).toHaveLength(1);
    expect(urlCardData(known).searchedUrl).toBe('https://example.com/1');
  });
});

describe('resetUrlCardStore', () => {
  it('clears both the card list and the data map for test isolation', () => {
    addUrlCard(stubDom, makeCardData('https://example.com/1'));
    resetUrlCardStore();
    expect(urlCards).toHaveLength(0);
    expect(urlCardDataById.size).toBe(0);
  });
});
