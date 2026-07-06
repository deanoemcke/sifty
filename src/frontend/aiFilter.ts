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
