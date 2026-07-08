import { getElement } from "./domUtils";
import { formatListingPrice } from "./priceFormat";
import { promptHash } from "./renderUtils";
import { applyClientFilters, getOrderedListings, renderDerived } from "./resultsView";
import {
  aiFilterPendingRun,
  isAiFilterRunning,
  listingsByUrl,
  setAiFilterPendingRun,
  setIsAiFilterRunning,
} from "./state";
import { setStatus } from "./statusBar";
import { streamPostAsync } from "./streamPost";

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
 * Guarded entry point for the debounced auto-run wired to the AI filter
 * textarea's `input` event. Must stay a zero-argument function: the debounce
 * wrapper forwards whatever arguments it's invoked with, and `addEventListener`
 * invokes listeners with the DOM `Event` — accepting a parameter here would
 * receive that `Event` object instead of any caller-supplied value.
 */
export function requestAiFilterRunIfPromptLongEnough(): void {
  const prompt = getElement<HTMLTextAreaElement>("aiFilter").value;
  if (!shouldAutoRunAiFilter(prompt)) return;
  requestAiFilterRun();
}

export async function runAiFilterAsync(): Promise<void> {
  if (isAiFilterRunning) {
    setAiFilterPendingRun(true);
    return;
  }

  const prompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
  if (!prompt) return;
  const hash = promptHash(prompt);
  const toCheck = getOrderedListings().filter((item) => item.aiCheckedHash !== hash);
  if (toCheck.length === 0) return;

  setIsAiFilterRunning(true);
  renderDerived();

  let streamError: string | null = null;

  try {
    await streamPostAsync(
      "/api/ai-filter",
      {
        prompt,
        listings: toCheck.map((item) => ({
          url: item.data.url,
          title: item.data.title,
          price: formatListingPrice(item.data.price),
          location: item.data.location,
          description: (item.data.description ?? "").slice(0, 300),
        })),
      },
      (event) => {
        if (event.type === "result") {
          for (const result of event.results as Array<{
            url: string;
            pass: boolean;
            reason: string | null;
          }>) {
            const item = listingsByUrl.get(result.url);
            if (item) {
              item.aiCheckedHash = hash;
              item.aiFilterReason = result.pass ? null : (result.reason ?? "No reason given");
            }
          }
          applyClientFilters();
        } else if (event.type === "error") {
          streamError = event.message as string;
        }
      },
    );
    if (streamError) throw new Error(streamError);
  } catch (error) {
    setStatus((error as Error).message, "error");
  } finally {
    setIsAiFilterRunning(false);
    renderDerived();
    if (aiFilterPendingRun) {
      setAiFilterPendingRun(false);
      void runAiFilterAsync();
    }
  }
}
