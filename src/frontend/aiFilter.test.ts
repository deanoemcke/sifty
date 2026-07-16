// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_FILTER_DEBOUNCE_MS,
  clearAiFilterResults,
  MIN_AI_FILTER_PROMPT_LENGTH,
  requestAiFilterRunIfPromptLongEnough,
  runAiFilterAsync,
  scheduleAiFilterRun,
  shouldAutoRunAiFilter,
} from './aiFilter';
import { populateShowControls } from './showDropdown';
import { isAiFilterRunning, type ListingItem, listingsByUrl, resetState } from './state';
import { makeListing, makeListingItem } from './testFixtures';
import { addUrlCard, resetUrlCardStore, type UrlCardDom } from './urlCardStore';

function makeListingItemAt(url: string): ListingItem {
  return makeListingItem({ data: makeListing({ url, title: url, price: null, location: '' }) });
}

describe('scheduleAiFilterRun', () => {
  it('calls runAiFilterAsync when the filter is not already running', () => {
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

  it('sets aiFilterPendingRun to true and does not call runAiFilterAsync when the filter is already running', () => {
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

// Stubs the fetch call `streamPostAsync` makes, streaming one line per chunk —
// mirrors stubQuickSearchStream in quickSearch.test.ts.
function stubAiFilterStream(chunks: string[]): void {
  const encoder = new TextEncoder();
  const pendingChunks = [...chunks];
  const reader = {
    read: async () =>
      pendingChunks.length > 0
        ? { value: encoder.encode(pendingChunks.shift()), done: false }
        : { value: undefined, done: true },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: { getReader: () => reader },
    })
  );
}

function makeCardDom(): UrlCardDom {
  const criteriaElement = document.createElement('div');
  criteriaElement.innerHTML = '<div class="criteria-grid"></div>';
  return {
    containerElement: document.createElement('div'),
    input: document.createElement('textarea'),
    linkElement: document.createElement('a'),
    editButton: document.createElement('button'),
    removeButton: document.createElement('button'),
    criteriaElement,
    cacheStatusElement: document.createElement('div'),
    statusElement: document.createElement('div'),
  };
}

describe('runAiFilterAsync', () => {
  beforeEach(() => {
    resetState();
    resetUrlCardStore();
    document.body.innerHTML = `
      <div id="resultsSection" class="hidden"></div>
      <div id="listingsContainer"></div>
      <button id="deepBtn"></button>
      <textarea id="aiFilter">laptop</textarea>
      <button id="aiFilterBtn"></button>
      <div id="showDropdown"></div>
    `;
    populateShowControls();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the AI-assigned relevance score onto the listing when a result event arrives', async () => {
    const url = 'https://example.com/1';
    const item: ListingItem = makeListingItem({
      data: makeListing({ url, title: 'Item', location: 'Auckland' }),
    });
    listingsByUrl.set(url, item);
    addUrlCard(makeCardDom(), {
      searchStatus: 'done',
      searchedUrl: url,
      searchId: null,
      listingUrls: [url],
      lastProgress: null,
      errorMessage: null,
      wasCancelled: false,
      isEditing: false,
    });

    stubAiFilterStream([
      `data: {"type":"result","results":[{"url":"${url}","pass":true,"reason":null,"relevance":7}]}\n`,
    ]);

    await runAiFilterAsync();

    expect(item.data.relevance).toBe(7);
  });
});

describe('AI_FILTER_DEBOUNCE_MS', () => {
  it('is long enough to absorb a normal typing pause instead of resubmitting on every gap', () => {
    // The debounce interval must comfortably exceed a mid-sentence typing pause
    // so normal typing doesn't resubmit the full listing set to the LLM on
    // every keystroke gap. 500ms (the pre-fix value) fires far too often.
    expect(AI_FILTER_DEBOUNCE_MS).toBeGreaterThanOrEqual(800);
  });
});

describe('shouldAutoRunAiFilter', () => {
  it('is false when the prompt is shorter than the minimum length', () => {
    expect(shouldAutoRunAiFilter('a'.repeat(MIN_AI_FILTER_PROMPT_LENGTH - 1))).toBe(false);
  });

  it('is false when the prompt is only whitespace padded above the minimum length', () => {
    expect(shouldAutoRunAiFilter(`  ${'a'.repeat(MIN_AI_FILTER_PROMPT_LENGTH - 1)}  `)).toBe(false);
  });

  it('is true when the prompt meets the minimum length', () => {
    expect(shouldAutoRunAiFilter('a'.repeat(MIN_AI_FILTER_PROMPT_LENGTH))).toBe(true);
  });
});

describe('requestAiFilterRunIfPromptLongEnough', () => {
  beforeEach(() => {
    resetState();
    resetUrlCardStore();
    document.body.innerHTML = `
      <textarea id="aiFilter"></textarea>
      <button id="deepBtn"></button>
      <button id="aiFilterBtn"></button>
      <div id="showDropdown"></div>
    `;
    populateShowControls();
  });

  it('does not start a run when the prompt is shorter than the minimum length', () => {
    const textarea = document.getElementById('aiFilter') as HTMLTextAreaElement;
    textarea.value = 'a'.repeat(MIN_AI_FILTER_PROMPT_LENGTH - 1);

    requestAiFilterRunIfPromptLongEnough();

    // A real run sets isAiFilterRunning synchronously (before its first
    // await), so this stays false only if the guard skipped the run.
    expect(isAiFilterRunning).toBe(false);
  });

  it("stays a zero-argument function so it's safe to invoke as a debounced DOM event listener", () => {
    // debounce() forwards whatever arguments it's called with, and
    // addEventListener invokes listeners with the DOM Event — this must not
    // crash or be treated as a caller-supplied dependency when called that way.
    const textarea = document.getElementById('aiFilter') as HTMLTextAreaElement;
    textarea.value = '';
    const fakeInputEvent = new Event('input');

    expect(() =>
      (requestAiFilterRunIfPromptLongEnough as unknown as (event: Event) => void)(fakeInputEvent)
    ).not.toThrow();
  });

  it('clears a previously filtered-out listing when the prompt is emptied', () => {
    const item = makeListingItemAt('https://l/1');
    item.aiFilterReason = 'too old';
    listingsByUrl.set('https://l/1', item);
    const textarea = document.getElementById('aiFilter') as HTMLTextAreaElement;
    textarea.value = '';

    requestAiFilterRunIfPromptLongEnough();

    expect(listingsByUrl.get('https://l/1')?.aiFilterReason).toBeNull();
  });

  it('does not clear an existing filtered-out listing while the prompt is short but non-empty', () => {
    const item = makeListingItemAt('https://l/1');
    item.aiFilterReason = 'too old';
    listingsByUrl.set('https://l/1', item);
    const textarea = document.getElementById('aiFilter') as HTMLTextAreaElement;
    textarea.value = 'ab';

    requestAiFilterRunIfPromptLongEnough();

    expect(listingsByUrl.get('https://l/1')?.aiFilterReason).toBe('too old');
  });
});

describe('clearAiFilterResults', () => {
  beforeEach(() => {
    resetState();
    resetUrlCardStore();
    document.body.innerHTML = `
      <button id="deepBtn"></button>
      <textarea id="aiFilter"></textarea>
      <button id="aiFilterBtn"></button>
      <div id="showDropdown"></div>
    `;
    populateShowControls();
  });

  it('resets aiFilterReason and aiCheckedHash to null for every listing', () => {
    const filtered = makeListingItemAt('https://l/1');
    filtered.aiFilterReason = 'too old';
    filtered.aiCheckedHash = 123;
    const passed = makeListingItemAt('https://l/2');
    passed.aiCheckedHash = 456;
    listingsByUrl.set(filtered.data.url, filtered);
    listingsByUrl.set(passed.data.url, passed);

    clearAiFilterResults();

    expect(listingsByUrl.get('https://l/1')?.aiFilterReason).toBeNull();
    expect(listingsByUrl.get('https://l/1')?.aiCheckedHash).toBeNull();
    expect(listingsByUrl.get('https://l/2')?.aiCheckedHash).toBeNull();
  });
});
