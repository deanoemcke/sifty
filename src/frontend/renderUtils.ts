// DJB2-style hash of the AI-filter prompt; listings remember the hash they
// were last checked against so stale filter results can be detected.
export function promptHash(inputString: string): number {
  let h = 5381;
  for (let charIndex = 0; charIndex < inputString.length; charIndex++)
    h = ((h * 33) ^ inputString.charCodeAt(charIndex)) >>> 0;
  return h;
}

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
