// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Listing } from "../lib/recipes/base";
import {
  AI_FILTER_DEBOUNCE_MS,
  clearAiFilterResults,
  MIN_AI_FILTER_PROMPT_LENGTH,
  requestAiFilterRunIfPromptLongEnough,
  scheduleAiFilterRun,
  shouldAutoRunAiFilter,
} from "./aiFilter";
import { isAiFilterRunning, type ListingItem, listingsByUrl, resetState } from "./state";

function makeListingItem(url: string): ListingItem {
  return {
    data: {
      source: "trademe",
      title: url,
      price: null,
      location: "",
      url,
    } as Listing,
    hasBeenDeepSearched: false,
    aiCheckedHash: null,
    aiFilterReason: null,
  };
}

describe("scheduleAiFilterRun", () => {
  it("calls runAiFilterAsync when the filter is not already running", () => {
    const runAiFilterAsync = vi.fn();
    const setAiFilterPendingRun = vi.fn();

    scheduleAiFilterRun({
      isAiFilterRunning: false,
      runAiFilterAsync,
      setAiFilterPendingRun,
    });

    expect(runAiFilterAsync).toHaveBeenCalledOnce();
    expect(setAiFilterPendingRun).not.toHaveBeenCalled();
  });

  it("sets aiFilterPendingRun to true and does not call runAiFilterAsync when the filter is already running", () => {
    const runAiFilterAsync = vi.fn();
    const setAiFilterPendingRun = vi.fn();

    scheduleAiFilterRun({
      isAiFilterRunning: true,
      runAiFilterAsync,
      setAiFilterPendingRun,
    });

    expect(setAiFilterPendingRun).toHaveBeenCalledOnce();
    expect(setAiFilterPendingRun).toHaveBeenCalledWith(true);
    expect(runAiFilterAsync).not.toHaveBeenCalled();
  });
});

describe("AI_FILTER_DEBOUNCE_MS", () => {
  it("is long enough to absorb a normal typing pause instead of resubmitting on every gap", () => {
    // The debounce interval must comfortably exceed a mid-sentence typing pause
    // so normal typing doesn't resubmit the full listing set to the LLM on
    // every keystroke gap. 500ms (the pre-fix value) fires far too often.
    expect(AI_FILTER_DEBOUNCE_MS).toBeGreaterThanOrEqual(800);
  });
});

describe("shouldAutoRunAiFilter", () => {
  it("is false when the prompt is shorter than the minimum length", () => {
    expect(shouldAutoRunAiFilter("a".repeat(MIN_AI_FILTER_PROMPT_LENGTH - 1))).toBe(false);
  });

  it("is false when the prompt is only whitespace padded above the minimum length", () => {
    expect(shouldAutoRunAiFilter(`  ${"a".repeat(MIN_AI_FILTER_PROMPT_LENGTH - 1)}  `)).toBe(
      false,
    );
  });

  it("is true when the prompt meets the minimum length", () => {
    expect(shouldAutoRunAiFilter("a".repeat(MIN_AI_FILTER_PROMPT_LENGTH))).toBe(true);
  });
});

describe("requestAiFilterRunIfPromptLongEnough", () => {
  beforeEach(() => {
    resetState();
    document.body.innerHTML = `
      <textarea id="aiFilter"></textarea>
      <span id="resultCount"></span>
      <span id="totalCount"></span>
      <button id="deepBtn"></button>
      <span id="aiFilterStatus"></span>
    `;
  });

  it("does not start a run when the prompt is shorter than the minimum length", () => {
    const textarea = document.getElementById("aiFilter") as HTMLTextAreaElement;
    textarea.value = "a".repeat(MIN_AI_FILTER_PROMPT_LENGTH - 1);

    requestAiFilterRunIfPromptLongEnough();

    // A real run sets isAiFilterRunning synchronously (before its first
    // await), so this stays false only if the guard skipped the run.
    expect(isAiFilterRunning).toBe(false);
  });

  it("stays a zero-argument function so it's safe to invoke as a debounced DOM event listener", () => {
    // debounce() forwards whatever arguments it's called with, and
    // addEventListener invokes listeners with the DOM Event — this must not
    // crash or be treated as a caller-supplied dependency when called that way.
    const textarea = document.getElementById("aiFilter") as HTMLTextAreaElement;
    textarea.value = "";
    const fakeInputEvent = new Event("input");

    expect(() =>
      (requestAiFilterRunIfPromptLongEnough as unknown as (event: Event) => void)(
        fakeInputEvent,
      ),
    ).not.toThrow();
  });

  it("clears a previously filtered-out listing when the prompt is emptied", () => {
    listingsByUrl.set("https://l/1", makeListingItem("https://l/1"));
    listingsByUrl.get("https://l/1")!.aiFilterReason = "too old";
    const textarea = document.getElementById("aiFilter") as HTMLTextAreaElement;
    textarea.value = "";

    requestAiFilterRunIfPromptLongEnough();

    expect(listingsByUrl.get("https://l/1")!.aiFilterReason).toBeNull();
    expect(document.getElementById("aiFilterStatus")!.textContent).toBe("Filtered 0 results");
  });

  it("does not clear an existing filtered-out listing while the prompt is short but non-empty", () => {
    listingsByUrl.set("https://l/1", makeListingItem("https://l/1"));
    listingsByUrl.get("https://l/1")!.aiFilterReason = "too old";
    const textarea = document.getElementById("aiFilter") as HTMLTextAreaElement;
    textarea.value = "ab";

    requestAiFilterRunIfPromptLongEnough();

    expect(listingsByUrl.get("https://l/1")!.aiFilterReason).toBe("too old");
  });
});

describe("clearAiFilterResults", () => {
  beforeEach(() => {
    resetState();
    document.body.innerHTML = `
      <span id="resultCount"></span>
      <span id="totalCount"></span>
      <button id="deepBtn"></button>
      <span id="aiFilterStatus"></span>
    `;
  });

  it("resets aiFilterReason and aiCheckedHash to null for every listing", () => {
    const filtered = makeListingItem("https://l/1");
    filtered.aiFilterReason = "too old";
    filtered.aiCheckedHash = 123;
    const passed = makeListingItem("https://l/2");
    passed.aiCheckedHash = 456;
    listingsByUrl.set(filtered.data.url, filtered);
    listingsByUrl.set(passed.data.url, passed);

    clearAiFilterResults();

    expect(listingsByUrl.get("https://l/1")!.aiFilterReason).toBeNull();
    expect(listingsByUrl.get("https://l/1")!.aiCheckedHash).toBeNull();
    expect(listingsByUrl.get("https://l/2")!.aiCheckedHash).toBeNull();
  });
});
