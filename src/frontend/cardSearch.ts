/**
 * Dispatches `searchFn` for every card in `cards`.
 *
 * This is the single owner of the "kick off a search for each URL card"
 * pattern — both loadDiscoveryResults and loadSavedSearchAsync delegate
 * to this function so the dispatch logic has one definition.
 */
export function fireAllCardSearches<T>(cards: readonly T[], searchFn: (card: T) => void): void {
  for (const card of cards) searchFn(card);
}
