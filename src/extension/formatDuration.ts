export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
// Hours read better than days up to two days ("40 hours" beats "1 day").
const HOURS_UNTIL_DAYS = 48;

export function pluralise(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

// A non-negative span as people say it: the largest sensible unit, rounded down.
export function formatDuration(durationMs: number): string {
  if (durationMs < MINUTE_MS) return 'less than a minute';
  if (durationMs < HOUR_MS) return pluralise(Math.floor(durationMs / MINUTE_MS), 'minute');
  if (durationMs < HOURS_UNTIL_DAYS * HOUR_MS) {
    return pluralise(Math.floor(durationMs / HOUR_MS), 'hour');
  }
  return pluralise(Math.floor(durationMs / DAY_MS), 'day');
}
