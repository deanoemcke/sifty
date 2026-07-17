// Standardised search status wording — all user-visible search progress text
// is composed here from semantic state, never hand-built at call sites.

import type { QuickSearchProgress } from '../lib/recipes/base';
import type { UrlCardSearchStatus } from './state';

export type CardStatusKind = 'info' | 'success' | 'error';

export interface CardStatusSnapshot {
  searchStatus: UrlCardSearchStatus;
  lastProgress: QuickSearchProgress | null;
  listingsFoundCount: number;
  errorMessage: string | null;
  wasCancelled: boolean;
}

function plural(count: number): string {
  return count !== 1 ? 's' : '';
}

export function listingsCountText(count: number): string {
  return `${count} listing${plural(count)}`;
}

export function progressText(progress: QuickSearchProgress): string {
  switch (progress.phase) {
    case 'loading':
      return 'Loading…';
    case 'counted':
      return `${progress.totalResults} result${plural(progress.totalResults)} across ${progress.totalPages} page${plural(progress.totalPages)}`;
    case 'paging':
      return progress.totalPages === undefined
        ? `Fetching page ${progress.page}…`
        : `Fetching page ${progress.page}/${progress.totalPages}`;
    case 'collecting':
      return `Found ${listingsCountText(progress.foundSoFar)}${progress.isLoadingMore ? ', loading more…' : '…'}`;
  }
}

// Boundary validation for progress events arriving over the SSE stream.
export function parseQuickSearchProgress(raw: Record<string, unknown>): QuickSearchProgress | null {
  switch (raw.phase) {
    case 'loading':
      return { phase: 'loading' };
    case 'counted':
      return typeof raw.totalResults === 'number' && typeof raw.totalPages === 'number'
        ? { phase: 'counted', totalResults: raw.totalResults, totalPages: raw.totalPages }
        : null;
    case 'paging':
      return typeof raw.page === 'number'
        ? {
            phase: 'paging',
            page: raw.page,
            ...(typeof raw.totalPages === 'number' ? { totalPages: raw.totalPages } : {}),
          }
        : null;
    case 'collecting':
      return typeof raw.foundSoFar === 'number'
        ? {
            phase: 'collecting',
            foundSoFar: raw.foundSoFar,
            isLoadingMore: raw.isLoadingMore === true,
          }
        : null;
    default:
      return null;
  }
}

export function cardStatusText(
  snapshot: CardStatusSnapshot
): { text: string; kind: CardStatusKind } | null {
  const { searchStatus, lastProgress, listingsFoundCount, errorMessage, wasCancelled } = snapshot;
  if (searchStatus === 'searching')
    return { text: lastProgress ? progressText(lastProgress) : 'Fetching listings…', kind: 'info' };
  if (searchStatus === 'cancelling') return { text: 'Cancelling…', kind: 'info' };
  if (wasCancelled)
    return { text: `Cancelled — ${listingsCountText(listingsFoundCount)}`, kind: 'error' };
  if (searchStatus === 'idle' && errorMessage) return { text: errorMessage, kind: 'error' };
  if (searchStatus === 'done')
    return errorMessage
      ? { text: errorMessage, kind: 'error' }
      : { text: listingsCountText(listingsFoundCount), kind: 'success' };
  return null;
}
