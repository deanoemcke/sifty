// ── URL card store ────────────────────────────────────────────────────────────
// Owns the live URL cards: each card is a stable id paired with the row's DOM
// handles; the id also keys state.urlCardDataById, which stays DOM-free.
// Joining by id (rather than array position) makes the two stores structurally
// unable to drift out of sync with each other.

import { type UrlCardData, urlCardDataById } from './state';

export interface UrlCardDom {
  containerElement: HTMLElement;
  input: HTMLTextAreaElement;
  // Truncated hyperlink shown in place of the input once a search has run.
  linkElement: HTMLAnchorElement;
  editButton: HTMLButtonElement;
  removeButton: HTMLButtonElement;
  // Criteria block below the status line; hidden until criteria arrive.
  criteriaElement: HTMLElement;
  cacheStatusElement: HTMLElement;
  statusElement: HTMLElement;
}

export type UrlCard = { id: string; dom: UrlCardDom };

export const urlCards: UrlCard[] = [];

export function urlCardData(card: UrlCard): UrlCardData {
  const data = urlCardDataById.get(card.id);
  if (!data) throw new Error(`No urlCardData for card id ${card.id}`);
  return data;
}

export function addUrlCard(dom: UrlCardDom, data: UrlCardData): UrlCard {
  const card: UrlCard = { id: crypto.randomUUID(), dom };
  urlCardDataById.set(card.id, data);
  urlCards.push(card);
  return card;
}

export function removeUrlCardEntry(card: UrlCard): void {
  const cardIndex = urlCards.indexOf(card);
  if (cardIndex !== -1) {
    urlCards.splice(cardIndex, 1);
    urlCardDataById.delete(card.id);
  }
}

export function resetUrlCardStore(): void {
  urlCards.length = 0;
  urlCardDataById.clear();
}
