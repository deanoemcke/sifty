import { describe, expect, it } from 'vitest';
import type { RunHistoryEntry } from '../nativeHost/handleMessage';
import { describeRunHistory } from './describeRunHistory';

const NOW_MS = Date.parse('2026-11-25T00:00:00Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function makeEntry(overrides: Partial<RunHistoryEntry> = {}): RunHistoryEntry {
  return {
    id: 'search-1',
    name: 'Search',
    lastRunAtMs: NOW_MS - 3 * HOUR_MS,
    lastRunSucceeded: true,
    lastRunDetailLines: [],
    nextDueAtMs: NOW_MS + HOUR_MS,
    ...overrides,
  };
}

describe('describeRunHistory', () => {
  it('returns nothing when there are no alert-enabled searches', () => {
    expect(describeRunHistory([], NOW_MS)).toEqual([]);
  });

  it('describes a search that has never run as due on the next run, not overdue', () => {
    const [row] = describeRunHistory(
      [makeEntry({ lastRunAtMs: null, lastRunSucceeded: null, nextDueAtMs: null })],
      NOW_MS
    );

    expect(row).toMatchObject({
      result: 'never-run',
      lastRunText: 'Never run',
      dueText: 'Due on the next run',
      isOverdue: false,
    });
  });

  it('describes a successful run with its age and when the next one is due', () => {
    const [row] = describeRunHistory([makeEntry()], NOW_MS);

    expect(row).toMatchObject({
      result: 'ok',
      lastRunText: '3 hours ago',
      dueText: 'Due in 1 hour',
      isOverdue: false,
      failureLines: [],
    });
  });

  it('keeps the recorded failure lines of a failed run unchanged', () => {
    const [row] = describeRunHistory(
      [
        makeEntry({
          lastRunSucceeded: false,
          lastRunDetailLines: ['scrape:Timed out', 'ai-filter:Rate limited'],
        }),
      ],
      NOW_MS
    );

    expect(row).toMatchObject({
      result: 'failed',
      failureLines: ['scrape:Timed out', 'ai-filter:Rate limited'],
    });
  });

  it('says "Due now" for a search that became due recently, since ticks are every half hour', () => {
    const [row] = describeRunHistory([makeEntry({ nextDueAtMs: NOW_MS - 10 * MINUTE_MS })], NOW_MS);

    expect(row).toMatchObject({ dueText: 'Due now', isOverdue: false });
  });

  it('flags a search that is well past due as overdue, saying by how much', () => {
    const [row] = describeRunHistory(
      [makeEntry({ lastRunAtMs: NOW_MS - 6 * DAY_MS, nextDueAtMs: NOW_MS - 5 * DAY_MS })],
      NOW_MS
    );

    expect(row).toMatchObject({ dueText: 'Overdue by 5 days', isOverdue: true });
  });

  it('lists failed searches first, then the most overdue, then the rest by name', () => {
    const rows = describeRunHistory(
      [
        makeEntry({ id: 'fine-b', name: 'Banana' }),
        makeEntry({ id: 'fine-a', name: 'Apple' }),
        makeEntry({ id: 'late-small', name: 'Late small', nextDueAtMs: NOW_MS - 2 * HOUR_MS }),
        makeEntry({ id: 'late-big', name: 'Late big', nextDueAtMs: NOW_MS - 3 * DAY_MS }),
        makeEntry({ id: 'broken', name: 'Broken', lastRunSucceeded: false }),
      ],
      NOW_MS
    );

    expect(rows.map((row) => row.id)).toEqual([
      'broken',
      'late-big',
      'late-small',
      'fine-a',
      'fine-b',
    ]);
  });

  it('reports a run with no recorded outcome as unknown, not as a success', () => {
    const [row] = describeRunHistory([makeEntry({ lastRunSucceeded: null })], NOW_MS);

    expect(row.result).toBe('unknown');
  });
});
