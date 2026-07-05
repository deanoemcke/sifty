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
  const card = (keyboardEvent.target as HTMLElement).closest<HTMLElement>(".listing-card");
  if (!card) return;
  keyboardEvent.preventDefault();
  openCard(card);
}
