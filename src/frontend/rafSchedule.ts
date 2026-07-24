// Coalesces rapid-fire calls into a single invocation on the next animation
// frame. Unlike debounce() (which delays and resets on every call), this
// never pushes the deadline out — the first call in a burst schedules the
// frame, every subsequent call before that frame fires just replaces the
// arguments that will be used, and the wrapped function always runs with the
// most recently supplied arguments exactly once per frame.
export type RafScheduled<Args extends unknown[]> = ((...args: Args) => void) & {
  // Drops any not-yet-fired frame without invoking fn — distinct from just
  // letting the frame fire, which would still run fn with stale args against
  // whatever state happens to exist when the callback lands (e.g. a test's
  // torn-down DOM). Callers that only want to stop a pending invocation from
  // firing (test cleanup; see resetFrameMutationSchedulingForTests in
  // resultsView.ts) should use this instead of forcing an early flush.
  cancel: () => void;
};

export function rafSchedule<Args extends unknown[]>(
  fn: (...args: Args) => void
): RafScheduled<Args> {
  let pendingArgs: Args | undefined;
  let frameId: number | undefined;
  const scheduled = ((...args: Args): void => {
    pendingArgs = args;
    if (frameId !== undefined) return;
    frameId = requestAnimationFrame(() => {
      frameId = undefined;
      const argsToApply = pendingArgs as Args;
      pendingArgs = undefined;
      fn(...argsToApply);
    });
  }) as RafScheduled<Args>;
  scheduled.cancel = (): void => {
    if (frameId !== undefined) cancelAnimationFrame(frameId);
    frameId = undefined;
    pendingArgs = undefined;
  };
  return scheduled;
}
