// Server-side only — logs quick-search progress/error events reported by a
// recipe's onEvent callback. Single consumer: the headless scheduler
// (scheduler.ts).

import type { QuickSearchProgress } from '../lib/recipes/base';
import type { QuickSearchCacheEvent } from './services/quickSearch';

export function describeQuickSearchProgress(progress: QuickSearchProgress): string {
  switch (progress.phase) {
    case 'loading':
      return 'loading';
    case 'counted':
      return `${progress.totalResults} result(s) across ${progress.totalPages} page(s)`;
    case 'paging':
      return progress.totalPages === undefined
        ? `fetching page ${progress.page}`
        : `fetching page ${progress.page}/${progress.totalPages}`;
    case 'collecting':
      return `found ${progress.foundSoFar} so far${progress.isLoadingMore ? ', loading more' : ''}`;
  }
}

// The scheduler previously discarded every recipe's onEvent callback, so a
// recipe that only ever reported progress/errors through onEvent (rather
// than its own direct console.log calls) was silently invisible in scheduler
// output — logging this generically here fixes that for every recipe at
// once, rather than relying on each recipe author to hand-add console calls.
export function logQuickSearchEvent(recipeName: string, event: QuickSearchCacheEvent): void {
  if (event.type === 'progress')
    console.log(`[${recipeName}] ${describeQuickSearchProgress(event)}`);
  if (event.type === 'error') console.error(`[${recipeName}] ${event.message}`);
}
