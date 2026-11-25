import type { RunHistoryEntry } from '../nativeHost/handleMessage';
import { SCHEDULER_TICK_INTERVAL_MINUTES } from '../server/schedulerSettingDefinitions';
import { formatDuration, MINUTE_MS } from './formatDuration';

export type RunResult = 'ok' | 'failed' | 'never-run' | 'unknown';

export type RunHistoryRowView = {
  id: string;
  name: string;
  result: RunResult;
  lastRunText: string;
  dueText: string;
  isOverdue: boolean;
  overdueByMs: number;
  // The scheduler's recorded `${kind}:${message}` lines, unchanged.
  failureLines: string[];
};

// A search that became due within two scheduler ticks is just waiting for its turn. Beyond that, something is stopping
// the scheduler (it's unloaded, a stale lock file, …).
const OVERDUE_GRACE_MS = 2 * SCHEDULER_TICK_INTERVAL_MINUTES * MINUTE_MS;

function describeResult(entry: RunHistoryEntry): RunResult {
  if (entry.lastRunAtMs === null) return 'never-run';
  if (entry.lastRunSucceeded === null) return 'unknown';
  return entry.lastRunSucceeded ? 'ok' : 'failed';
}

function describeRow(entry: RunHistoryEntry, nowMs: number): RunHistoryRowView {
  const overdueByMs = entry.nextDueAtMs === null ? 0 : nowMs - entry.nextDueAtMs;
  const isOverdue = overdueByMs > OVERDUE_GRACE_MS;

  let dueText: string;
  if (entry.nextDueAtMs === null) dueText = 'Due on the next run';
  else if (isOverdue) dueText = `Overdue by ${formatDuration(overdueByMs)}`;
  else if (overdueByMs >= 0) dueText = 'Due now';
  else dueText = `Due in ${formatDuration(-overdueByMs)}`;

  return {
    id: entry.id,
    name: entry.name,
    result: describeResult(entry),
    lastRunText:
      entry.lastRunAtMs === null ? 'Never run' : `${formatDuration(nowMs - entry.lastRunAtMs)} ago`,
    dueText,
    isOverdue,
    overdueByMs,
    failureLines: entry.lastRunDetailLines,
  };
}

// Problems first: failed runs, then searches furthest past due, then the rest by name.
export function describeRunHistory(entries: RunHistoryEntry[], nowMs: number): RunHistoryRowView[] {
  return entries
    .map((entry) => describeRow(entry, nowMs))
    .sort((first, second) => {
      const failedDifference =
        Number(second.result === 'failed') - Number(first.result === 'failed');
      if (failedDifference !== 0) return failedDifference;
      const overdueDifference = Number(second.isOverdue) - Number(first.isOverdue);
      if (overdueDifference !== 0) return overdueDifference;
      if (first.isOverdue) return second.overdueByMs - first.overdueByMs;
      return first.name.localeCompare(second.name);
    });
}
