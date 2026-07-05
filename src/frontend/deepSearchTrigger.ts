// Pure decision logic for whether opening a listing's modal should kick off
// a deep search, wait on one already in flight, or do nothing.

export type ModalDeepSearchAction = "none" | "start" | "wait";

export interface ModalDeepSearchDecisionInput {
  hasBeenDeepSearched: boolean;
  isCoveredByBulkSearch: boolean;
  isAlreadyFetchingSingle: boolean;
}

export function decideModalDeepSearchAction(
  input: ModalDeepSearchDecisionInput,
): ModalDeepSearchAction {
  if (input.hasBeenDeepSearched) return "none";
  if (input.isCoveredByBulkSearch || input.isAlreadyFetchingSingle) return "wait";
  return "start";
}
