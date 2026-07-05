export interface ApplyFilterBtnStateArgs {
  isFilterCurrent: boolean;
  isAiFilterRunning: boolean;
}

/**
 * Returns whether the "Apply filter" button should be disabled.
 *
 * The button is disabled when:
 * - `isFilterCurrent` is true (nothing to apply), OR
 * - `isAiFilterRunning` is true (a filter run is already in progress)
 *
 * Extracted as a named function so the logic is testable in isolation and
 * `renderDerived` has a single source of truth for this decision.
 */
export function shouldDisableApplyFilterBtn({
  isFilterCurrent,
  isAiFilterRunning,
}: ApplyFilterBtnStateArgs): boolean {
  return isFilterCurrent || isAiFilterRunning;
}
