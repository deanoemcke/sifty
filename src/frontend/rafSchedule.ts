// Coalesces rapid-fire calls into a single invocation on the next animation
// frame. Unlike debounce() (which delays and resets on every call), this
// never pushes the deadline out — the first call in a burst schedules the
// frame, every subsequent call before that frame fires just replaces the
// arguments that will be used, and the wrapped function always runs with the
// most recently supplied arguments exactly once per frame.
export function rafSchedule<Args extends unknown[]>(
  fn: (...args: Args) => void,
): (...args: Args) => void {
  let pendingArgs: Args | undefined;
  let frameId: number | undefined;
  return (...args: Args): void => {
    pendingArgs = args;
    if (frameId !== undefined) return;
    frameId = requestAnimationFrame(() => {
      frameId = undefined;
      const argsToApply = pendingArgs as Args;
      pendingArgs = undefined;
      fn(...argsToApply);
    });
  };
}
