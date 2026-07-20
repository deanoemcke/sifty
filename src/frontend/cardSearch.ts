/**
 * Dispatches `searchFn` for every card in `cards`, resolving once all of
 * them have settled.
 *
 * This is the single owner of the "kick off a search for each URL card"
 * pattern — both loadDiscoveryResults and loadSavedSearchAsync delegate
 * to this function so the dispatch logic has one definition.
 */
export function fireAllCardSearches<T>(
  cards: readonly T[],
  searchFn: (card: T) => Promise<void>
): Promise<void> {
  return Promise.all(cards.map((card) => searchFn(card))).then(() => undefined);
}
