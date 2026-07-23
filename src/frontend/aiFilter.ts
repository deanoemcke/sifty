import { formatListingPrice } from '../lib/priceFormat';
import { getElement } from './domUtils';
import { djb2Hash } from './renderUtils';
import { applyClientFilters, getOrderedListings, scheduleClientFilterUpdate } from './resultsView';
import {
  aiFilterPendingRun,
  isAiFilterRunning,
  listingsByUrl,
  setAiFilterPendingRun,
  setIsAiFilterRunning,
} from './state';
import { setStatus } from './statusBar';
import { streamPostAsync } from './streamPost';

// The "already checked" cache in `runAiFilterAsync` is keyed on a hash of the
// full prompt, so every keystroke changes the hash and makes the entire
// listing set look unchecked again. These two guards keep normal typing from
// resubmitting the full listing set to the LLM on every keystroke gap:
// a minimum prompt length (a couple of characters isn't a usable filter
// criteria yet) and a debounce interval long enough to absorb a natural
// pause between words/clauses, not just the gap between two keystrokes.
export const MIN_AI_FILTER_PROMPT_LENGTH = 8;
export const AI_FILTER_DEBOUNCE_MS = 1200;

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

// Named convenience wrapper so call sites don't repeat the deps object.
export function requestAiFilterRun(): void {
  scheduleAiFilterRun({ isAiFilterRunning, runAiFilterAsync, setAiFilterPendingRun });
}

/**
 * True once a prompt is long enough to be a usable filter criteria. Below
 * `MIN_AI_FILTER_PROMPT_LENGTH` a run would kick off a full LLM sweep over
 * every listing for what's still just a couple of typed characters.
 */
export function shouldAutoRunAiFilter(prompt: string): boolean {
  return prompt.trim().length >= MIN_AI_FILTER_PROMPT_LENGTH;
}

/**
 * Resets every listing's AI-filter result back to unchecked and re-applies
 * client-side filtering. Clearing the prompt back to empty leaves no
 * criteria to re-run against the LLM, but results from the last completed
 * run must not keep hiding listings — this is the only place that resets
 * `aiFilterReason` outside of a completed run.
 */
export function clearAiFilterResults(): void {
  const hasFilteredResults = [...listingsByUrl.values()].some(
    (item) => item.aiFilterReason !== null
  );
  for (const item of listingsByUrl.values()) {
    item.aiFilterReason = null;
    item.aiCheckedHash = null;
  }
  if (hasFilteredResults) applyClientFilters();
}

/**
 * Guarded entry point for the debounced auto-run wired to the AI filter
 * textarea's `input` event. Must stay a zero-argument function: the debounce
 * wrapper forwards whatever arguments it's invoked with, and `addEventListener`
 * invokes listeners with the DOM `Event` — accepting a parameter here would
 * receive that `Event` object instead of any caller-supplied value.
 */
export function requestAiFilterRunIfPromptLongEnough(): void {
  const prompt = getElement<HTMLTextAreaElement>('aiFilter').value;
  if (prompt.trim() === '') {
    clearAiFilterResults();
    return;
  }
  if (!shouldAutoRunAiFilter(prompt)) return;
  requestAiFilterRun();
}

export async function runAiFilterAsync(): Promise<void> {
  if (isAiFilterRunning) {
    setAiFilterPendingRun(true);
    return;
  }

  const prompt = getElement<HTMLTextAreaElement>('aiFilter').value.trim();
  if (!prompt) return;
  const hash = djb2Hash(prompt);
  const toCheck = getOrderedListings().filter((item) => item.aiCheckedHash !== hash);
  if (toCheck.length === 0) return;

  setIsAiFilterRunning(true);
  // Scheduled, not direct: the per-batch handler below also schedules, and
  // mixing a direct call with a scheduled one on the same
  // runWithViewTransition-wrapped mutator means whichever fires second
  // aborts the other's animation mid-flight — see the finally block below
  // for the matching call and its longer explanation.
  scheduleClientFilterUpdate();

  let streamError: string | null = null;

  try {
    await streamPostAsync(
      '/api/ai-filter',
      {
        prompt,
        listings: toCheck.map((item) => ({
          url: item.data.url,
          title: item.data.title,
          price: formatListingPrice(item.data.price),
          location: item.data.location,
          description: (item.data.description ?? '').slice(0, 300),
        })),
      },
      (event) => {
        if (event.type === 'result') {
          for (const result of event.results as Array<{
            url: string;
            pass: boolean;
            reason: string | null;
            relevance: number;
          }>) {
            const item = listingsByUrl.get(result.url);
            if (item) {
              item.aiCheckedHash = hash;
              item.aiFilterReason = result.pass ? null : (result.reason ?? 'No reason given');
              item.data.relevance = result.relevance;
            }
          }
          // Batches stream in from up to 3 concurrent backend requests, so a
          // burst of 'result' events can land within the same animation
          // frame — schedule (not call directly) so they coalesce into one
          // view transition instead of each aborting the last, same as
          // quickSearch.ts's per-listing stream (see
          // scheduleClientFilterUpdate's comment in resultsView.ts).
          scheduleClientFilterUpdate();
        } else if (event.type === 'error') {
          streamError = event.message as string;
        }
      }
    );
    if (streamError) throw new Error(streamError);
  } catch (error) {
    setStatus((error as Error).message, 'error');
  } finally {
    setIsAiFilterRunning(false);
    // Scheduled, not direct — see the run-start comment above. A single-batch
    // run (the common case, since BATCH_SIZE is 50) reaches this call within
    // a few milliseconds of the batch handler's own scheduleClientFilterUpdate()
    // call above: if this one called applyClientFilters() directly, it would
    // start its own view transition immediately, aborting the still-animating
    // one the scheduled call had just started a frame earlier — snapping
    // cards into place instead of letting them slide. Scheduling both means
    // they coalesce into whichever single frame is still pending, so only
    // one transition ever actually plays.
    scheduleClientFilterUpdate();
    if (aiFilterPendingRun) {
      setAiFilterPendingRun(false);
      void runAiFilterAsync();
    }
  }
}
