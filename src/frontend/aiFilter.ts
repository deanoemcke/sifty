export interface ScheduleAiFilterRunDeps {
  isAiFilterRunning: boolean;
  runAiFilterAsync: () => void;
  setAiFilterPendingRun: (value: boolean) => void;
}

/**
 * Schedules an AI filter run.
 *
 * If the filter is already running, marks a pending re-run so the `finally`
 * block in `runAiFilterAsync` will retry once the current run completes.
 * Otherwise, starts a new run immediately.
 *
 * This is the single owner of the "run or enqueue" scheduling policy — all
 * call sites delegate here so the logic has one definition and is testable
 * in isolation.
 */
export function scheduleAiFilterRun(deps: ScheduleAiFilterRunDeps): void {
  if (deps.isAiFilterRunning) {
    deps.setAiFilterPendingRun(true);
    return;
  }
  deps.runAiFilterAsync();
}
