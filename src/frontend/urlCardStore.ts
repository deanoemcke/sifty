// ── URL card store ────────────────────────────────────────────────────────────
// Owns the live URL cards: serialisable card data (mirrored into
// state.urlCardData, which stays DOM-free) paired with the row's DOM handles.
// All mutation goes through addUrlCard/removeUrlCardEntry so the two arrays
// can never drift out of index alignment.

import { type UrlCardData, urlCardData } from "./state";

export interface UrlCardDom {
  containerElement: HTMLElement;
  input: HTMLInputElement;
  // Truncated hyperlink shown in place of the input once a search has run.
  linkElement: HTMLAnchorElement;
  searchButton: HTMLButtonElement;
  removeButton: HTMLButtonElement;
  // Criteria block below the status line; hidden until criteria arrive.
  criteriaElement: HTMLElement;
  cacheStatusElement: HTMLElement;
  statusElement: HTMLElement;
}

export type UrlCard = { data: UrlCardData; dom: UrlCardDom };

export const urlCards: UrlCard[] = [];

export function addUrlCard(card: UrlCard): void {
  urlCards.push(card);
  urlCardData.push(card.data);
}

export function removeUrlCardEntry(card: UrlCard): void {
  const cardIndex = urlCards.indexOf(card);
  if (cardIndex !== -1) {
    urlCards.splice(cardIndex, 1);
    urlCardData.splice(cardIndex, 1);
  }
}

// Test isolation only — clears the DOM-bearing side; resetState() clears
// state.urlCardData.
export function resetUrlCardStore(): void {
  urlCards.length = 0;
}
