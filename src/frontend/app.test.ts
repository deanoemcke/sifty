// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Listing } from "../lib/recipes/base";
import { fireAllCardSearches } from "./cardSearch";

describe("fireAllCardSearches", () => {
  it("calls the search function exactly once per card", () => {
    const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const searchFn = vi.fn();
    fireAllCardSearches(cards, searchFn);
    expect(searchFn).toHaveBeenCalledTimes(3);
  });

  it("passes each card to the search function", () => {
    const cards = [{ id: "x" }, { id: "y" }];
    const searchFn = vi.fn();
    fireAllCardSearches(cards, searchFn);
    expect(searchFn).toHaveBeenNthCalledWith(1, cards[0]);
    expect(searchFn).toHaveBeenNthCalledWith(2, cards[1]);
  });

  it("does nothing when the card list is empty", () => {
    const searchFn = vi.fn();
    fireAllCardSearches([], searchFn);
    expect(searchFn).not.toHaveBeenCalled();
  });
});

// ── initApp() wiring ─────────────────────────────────────────────────────────
// The tests above exercise pure helpers in isolation. These mount the real
// index.html DOM and import "./app" (whose module-scope side effect calls
// initApp()) to assert that the wiring actually connects those helpers to
// live DOM events — a wiring mistake here (wrong element id, wrong event
// name, a debounce that was never applied) would pass every helper-level
// unit test while being broken in production.
//
// `requestAiFilterRunIfPromptLongEnough` is wrapped with `vi.fn(actual)` (not
// stubbed) so it still runs its real gating/scheduling logic, letting the
// debounce test observe the wiring *and* confirm it reaches all the way down
// to a real `streamPostAsync` call. `openListingCardModal` is stubbed outright
// since exercising real modal rendering is out of scope for a routing test.
vi.mock("./aiFilter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aiFilter")>();
  return {
    ...actual,
    requestAiFilterRunIfPromptLongEnough: vi.fn(actual.requestAiFilterRunIfPromptLongEnough),
  };
});

vi.mock("./listingDetail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./listingDetail")>();
  return { ...actual, openListingCardModal: vi.fn() };
});

vi.mock("./streamPost", () => ({
  streamPostAsync: vi.fn().mockResolvedValue(undefined),
}));

// index.html is the real DOM initApp() is written against — reading it here
// (rather than hand-rolling a fixture) keeps the test fixture from drifting
// out of sync with the markup app.ts actually wires up in production.
function loadIndexHtmlBodyFixture(): string {
  // Deliberately __dirname (not import.meta.url): under "@vitest-environment
  // jsdom" import.meta.url resolves to a fake http://localhost address rather
  // than a file:// URL, which fileURLToPath rejects.
  const indexHtmlPath = join(__dirname, "../../index.html");
  const indexHtml = readFileSync(indexHtmlPath, "utf-8");
  const bodyMatch = indexHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) throw new Error("index.html fixture: <body> tag not found");
  return bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "");
}

function appendListingCardFixture(): { openArea: HTMLElement; externalLink: HTMLElement } {
  const listingsContainer = document.getElementById("listingsContainer");
  if (!listingsContainer) throw new Error("#listingsContainer not found in fixture");
  const card = document.createElement("div");
  card.className = "listing-card";
  card.dataset.url = "https://example.com/listing/1";
  const openArea = document.createElement("div");
  openArea.className = "listing-open-area";
  openArea.textContent = "A vintage road bike";
  // Rendered as a sibling of .listing-open-area, never nested inside it —
  // mirrors resultsView.ts's real card markup.
  const externalLink = document.createElement("a");
  externalLink.className = "listing-external-link-btn";
  externalLink.textContent = "Open original";
  card.appendChild(openArea);
  card.appendChild(externalLink);
  listingsContainer.appendChild(card);
  return { openArea, externalLink };
}

function makeListingItem(url: string) {
  return {
    data: { source: "trademe", title: url, price: null, location: "", url } as Listing,
    hasBeenDeepSearched: false,
    aiCheckedHash: null,
    aiFilterReason: null,
  };
}

describe("initApp() wiring", () => {
  beforeEach(() => {
    // Fresh module instances per test so each dynamic import("./app") gets
    // its own isolated state.ts / urlCardStore.ts, rather than leaking
    // urlCards or listingsByUrl entries seeded by a previous test.
    vi.resetModules();
    // The vi.fn()s created inside vi.mock() factories are reused across
    // resetModules() cycles, so their call history must be cleared explicitly
    // or a later test would see calls recorded by an earlier one.
    vi.clearAllMocks();
    document.body.innerHTML = loadIndexHtmlBodyFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network disabled in app.test.ts wiring tests")),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  describe("AI filter auto-run", () => {
    it("does not run immediately, but reaches a real streamPostAsync call once the debounce interval elapses", async () => {
      vi.useFakeTimers();
      const { AI_FILTER_DEBOUNCE_MS, requestAiFilterRunIfPromptLongEnough } = await import(
        "./aiFilter"
      );
      const { streamPostAsync } = await import("./streamPost");
      const { listingsByUrl } = await import("./state");
      const { urlCards, urlCardData } = await import("./urlCardStore");

      await import("./app");

      // initApp() already created one blank url card (mirroring production
      // startup) — attach the seeded listing to that real card rather than
      // pushing a second, synthetic one, which would leave urlCards with an
      // entry missing DOM handles (e.g. removeButton) and break other code
      // that iterates every card, such as updateRemoveButtons().
      const url = "https://example.com/listing/1";
      listingsByUrl.set(url, makeListingItem(url));
      urlCardData(urlCards[0]).listingUrls = [url];

      const aiFilterInput = document.getElementById("aiFilter") as HTMLTextAreaElement;
      aiFilterInput.value = "good condition only please";
      aiFilterInput.dispatchEvent(new Event("input"));

      expect(vi.mocked(requestAiFilterRunIfPromptLongEnough)).not.toHaveBeenCalled();
      expect(vi.mocked(streamPostAsync)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(AI_FILTER_DEBOUNCE_MS);

      expect(vi.mocked(requestAiFilterRunIfPromptLongEnough)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(streamPostAsync)).toHaveBeenCalledTimes(1);
      const [endpoint, body] = vi.mocked(streamPostAsync).mock.calls[0];
      expect(endpoint).toBe("/api/ai-filter");
      expect((body as { prompt: string }).prompt).toBe("good condition only please");
    });

    it("collapses rapid typing within the debounce window into a single call", async () => {
      vi.useFakeTimers();
      const { AI_FILTER_DEBOUNCE_MS, requestAiFilterRunIfPromptLongEnough } = await import(
        "./aiFilter"
      );
      await import("./app");

      const aiFilterInput = document.getElementById("aiFilter") as HTMLTextAreaElement;

      aiFilterInput.value = "good cond";
      aiFilterInput.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(AI_FILTER_DEBOUNCE_MS / 2);

      aiFilterInput.value = "good condition, no rust";
      aiFilterInput.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(AI_FILTER_DEBOUNCE_MS / 2);

      // The first keystroke's timer should have been cancelled by the second,
      // so at 1x the debounce interval nothing has fired yet.
      expect(vi.mocked(requestAiFilterRunIfPromptLongEnough)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(AI_FILTER_DEBOUNCE_MS / 2);

      expect(vi.mocked(requestAiFilterRunIfPromptLongEnough)).toHaveBeenCalledTimes(1);
    });
  });

  describe("Enter-to-submit on discovery inputs", () => {
    it("clicks #discoveryBtn on Enter in the discovery prompt", async () => {
      await import("./app");
      const discoveryBtn = document.getElementById("discoveryBtn") as HTMLButtonElement;
      const clickSpy = vi.spyOn(discoveryBtn, "click");
      const promptInput = document.getElementById("discoveryPrompt") as HTMLTextAreaElement;

      promptInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("clicks #discoveryBtn on Enter in the max-price input", async () => {
      await import("./app");
      const discoveryBtn = document.getElementById("discoveryBtn") as HTMLButtonElement;
      const clickSpy = vi.spyOn(discoveryBtn, "click");
      const maxPriceInput = document.getElementById("discoveryMaxPrice") as HTMLInputElement;

      maxPriceInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("does not click #discoveryBtn on Shift+Enter (newline in the prompt)", async () => {
      await import("./app");
      const discoveryBtn = document.getElementById("discoveryBtn") as HTMLButtonElement;
      const clickSpy = vi.spyOn(discoveryBtn, "click");
      const promptInput = document.getElementById("discoveryPrompt") as HTMLTextAreaElement;

      promptInput.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(clickSpy).not.toHaveBeenCalled();
    });
  });

  describe("Sort by control", () => {
    it("populates the sort select with all options, defaulting to source-url", async () => {
      await import("./app");
      const sortSelect = document.getElementById("sortBy") as HTMLSelectElement;
      expect(Array.from(sortSelect.options).map((option) => option.value)).toEqual([
        "source-url",
        "best-match",
        "worst-match",
        "lowest-price",
        "highest-price",
      ]);
      expect(sortSelect.value).toBe("source-url");
    });

    it("updates state.sortBy when the select changes", async () => {
      await import("./app");
      const state = await import("./state");
      const sortSelect = document.getElementById("sortBy") as HTMLSelectElement;

      sortSelect.value = "best-match";
      sortSelect.dispatchEvent(new Event("change"));

      expect(state.sortBy).toBe("best-match");
    });
  });

  describe("listing card open-area vs. external-link click routing", () => {
    it("opens the listing modal for a click inside the open area", async () => {
      const { openListingCardModal } = await import("./listingDetail");
      await import("./app");
      const { openArea } = appendListingCardFixture();

      openArea.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(vi.mocked(openListingCardModal)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openListingCardModal).mock.calls[0][0]).toHaveProperty(
        "className",
        "listing-card",
      );
    });

    it("does not open the modal for a click on the external-link button", async () => {
      const { openListingCardModal } = await import("./listingDetail");
      await import("./app");
      const { externalLink } = appendListingCardFixture();

      externalLink.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(vi.mocked(openListingCardModal)).not.toHaveBeenCalled();
    });
  });
});
