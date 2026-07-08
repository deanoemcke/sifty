// Listing cards are plain divs opened via a delegated click listener, so
// keyboard/screen-reader access has to be restored explicitly: button
// semantics on each card, and Enter/Space activation on the container.

export function applyListingCardAccessibility(card: HTMLElement, listingTitle: string): void {
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", listingTitle);
}

export function handleListingCardKeydown(
  keyboardEvent: KeyboardEvent,
  openCard: (card: HTMLElement) => void,
): void {
  if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
  const target = keyboardEvent.target as HTMLElement;
  if (target.closest(".listing-external-link-btn")) return;
  const card = target.closest<HTMLElement>(".listing-card");
  if (!card) return;
  keyboardEvent.preventDefault();
  openCard(card);
}

// The external-link button lives inside .listing-open-area (next to the
// title) so it stays reachable in the tab order, but a click on it must
// navigate rather than also opening the modal underneath it.
export function resolveListingCardOpenArea(target: HTMLElement): HTMLElement | null {
  if (target.closest(".listing-external-link-btn")) return null;
  return target.closest<HTMLElement>(".listing-open-area");
}
