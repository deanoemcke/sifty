// Listing cards are plain divs opened via a delegated click listener, so
// keyboard/screen-reader access has to be restored explicitly: button
// semantics on each card, and Enter/Space activation on the container.

import { EXTERNAL_LINK_BUTTON_CLASS_NAME } from "./listingHtml";

export function applyListingCardAccessibility(card: HTMLElement, listingTitle: string): void {
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", listingTitle);
}

// Shared by the click and keydown paths below: the external-link button is
// a separately-focusable <a> rendered as a sibling of .listing-open-area
// (never nested inside it), but it still lives inside .listing-card, so
// both activation paths need to route around it rather than also opening
// the modal underneath it.
export function isExternalLinkTarget(target: HTMLElement): boolean {
  return target.closest(`.${EXTERNAL_LINK_BUTTON_CLASS_NAME}`) !== null;
}

export function handleListingCardKeydown(
  keyboardEvent: KeyboardEvent,
  openCard: (card: HTMLElement) => void,
): void {
  if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
  const target = keyboardEvent.target as HTMLElement;
  if (isExternalLinkTarget(target)) return;
  const card = target.closest<HTMLElement>(".listing-card");
  if (!card) return;
  keyboardEvent.preventDefault();
  openCard(card);
}

export function resolveListingCardOpenArea(target: HTMLElement): HTMLElement | null {
  if (isExternalLinkTarget(target)) return null;
  return target.closest<HTMLElement>(".listing-open-area");
}
