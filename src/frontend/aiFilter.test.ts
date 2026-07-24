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
import {
  applyClientFilters,
  getCardByUrl,
  renderCard,
  resetFrameMutationSchedulingForTests,
} from './resultsView';
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

// Waits for one real animation frame — used instead of fake timers to flush
// scheduleClientFilterUpdate()'s pending rAF-coalesced sweep. Real timers
// give a reliable ordering guarantee that fake timers didn't in this file:
// an awaited async function's promise always resolves via the microtask
// queue, which fully drains before any macrotask/rAF callback gets a chance
// to run — so checking state immediately after `await runAiFilterAsync()`
// is guaranteed to observe the pre-flush state, no explicit "don't fire yet"
// needed.
function flushAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
    // Clears any card-reveal/filter-sweep flush left armed by the previous
    // test (resultsView.ts's pendingFrameMutations/scheduleFrameMutationFlush
    // is module-level state shared across every test in this file) rather
    // than relying on every test remembering to await flushAnimationFrame()
    // before it ends.
    resetFrameMutationSchedulingForTests();
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

  it('coalesces multiple streamed result batches into a single animation-frame sweep instead of one per batch', async () => {
    // Regression test: a fast SSE burst of 'result' batches (the backend
    // runs up to 3 batches of 50 listings concurrently) used to call
    // applyClientFilters() directly once per batch — an O(n) full-grid sweep
    // each time, so a stream of many batches was O(n) per batch instead of
    // once overall. The fix routes the per-batch handler through
    // scheduleClientFilterUpdate(), which coalesces a burst into a single
    // sweep on the next animation frame.
    const urlA = 'https://example.com/a';
    const urlB = 'https://example.com/b';
    for (const url of [urlA, urlB]) {
      const item: ListingItem = makeListingItem({
        data: makeListing({ url, title: url, location: 'Auckland' }),
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
    }

    stubAiFilterStream([
      `data: {"type":"result","results":[{"url":"${urlA}","pass":true,"reason":null,"relevance":7}]}\n`,
      `data: {"type":"result","results":[{"url":"${urlB}","pass":true,"reason":null,"relevance":7}]}\n`,
    ]);

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

    await runAiFilterAsync();

    expect(rafSpy).toHaveBeenCalledTimes(1);
    rafSpy.mockRestore();
  });

  it('does not apply a filtered-out result until the scheduled frame flushes, even for a single-batch run', async () => {
    // Regression test for the actual reported bug: with only one batch (the
    // common case — BATCH_SIZE is 50, so most runs never hit the multi-batch
    // burst above), the run-start and finally-block calls used to call
    // applyClientFilters() directly while the batch handler scheduled — an
    // unnecessary extra full-grid sweep on top of the one the scheduled call
    // already covers. If any of the three call sites regress back to a
    // direct call, this card's filtered-out state would already be applied
    // synchronously here, before any frame has been flushed — an await'd
    // async function's promise always resolves via the microtask queue,
    // which fully drains before a real rAF callback gets a chance to run.
    const url = 'https://example.com/1';
    const item: ListingItem = makeListingItem({
      data: makeListing({ url, title: url, location: 'Auckland' }),
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
    renderCard(item);
    stubAiFilterStream([
      `data: {"type":"result","results":[{"url":"${url}","pass":false,"reason":"too expensive","relevance":1}]}\n`,
    ]);

    await runAiFilterAsync();

    expect(item.aiFilterReason).toBe('too expensive'); // state itself updates synchronously in the SSE handler
    expect(getCardByUrl(url)?.style.display).not.toBe('none'); // but the DOM sweep is still pending a frame

    await flushAnimationFrame();

    expect(getCardByUrl(url)?.style.display).toBe('none');
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

describe('ai-scanning overlay', () => {
  beforeEach(() => {
    resetState();
    resetUrlCardStore();
    resetFrameMutationSchedulingForTests();
    document.body.innerHTML = `
      <div id="resultsSection" class="hidden"></div>
      <div id="listingsContainer"></div>
      <button id="deepBtn"></button>
      <textarea id="aiFilter">laptop</textarea>
      <button id="aiFilterBtn"></button>
      <div id="showDropdown"></div>
      <div id="statusBar" class="hidden"></div>
    `;
    populateShowControls();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function renderCardAt(url: string): ListingItem {
    const item = makeListingItemAt(url);
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
    renderCard(item);
    return item;
  }

  it('marks a not-yet-checked card as ai-scanning once the run-start sweep flushes', async () => {
    // Regression test: applyClientFilters() at run-start is scheduled (not
    // called directly) so it coalesces onto the same rAF-scheduled call the
    // per-batch result handler uses — see the comments in aiFilter.ts. So
    // this now takes effect once the next animation frame flushes, not
    // synchronously. Stubs a fetch that never resolves so the run stays
    // parked right after its run-start sweep — with a real batch result in
    // the mix, the whole run (batch handler included) can settle before a
    // single real animation frame even fires, since a mocked stream resolves
    // over microtasks orders of magnitude faster than a ~16ms frame, making
    // "before any result" unobservable rather than testing anything.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    const url = 'https://example.com/1';
    renderCardAt(url);

    void runAiFilterAsync(); // never resolves — the run is deliberately left pending
    await flushAnimationFrame();

    expect(getCardByUrl(url)?.classList.contains('ai-scanning')).toBe(true);
  });

  it('clears ai-scanning once the run completes normally', async () => {
    const url = 'https://example.com/1';
    renderCardAt(url);
    stubAiFilterStream([
      `data: {"type":"result","results":[{"url":"${url}","pass":true,"reason":null,"relevance":7}]}\n`,
    ]);

    await runAiFilterAsync();
    await flushAnimationFrame();

    expect(getCardByUrl(url)?.classList.contains('ai-scanning')).toBe(false);
  });

  it('leaves ai-scanning on a card whose result never arrived because the stream errored out', async () => {
    // Unlike a Set the run pre-populates and then unconditionally clears at
    // the end, "pending" is derived from aiCheckedHash vs. the current
    // prompt's hash — so a card an error prevented from actually being
    // checked honestly keeps showing as pending, instead of the run's
    // cleanup silently hiding that it was never verified.
    const url = 'https://example.com/1';
    renderCardAt(url);
    stubAiFilterStream(['data: {"type":"error","message":"boom"}\n']);

    await runAiFilterAsync();
    await flushAnimationFrame();

    expect(getCardByUrl(url)?.classList.contains('ai-scanning')).toBe(true);
  });

  it('marks a card as ai-scanning even when it was never part of any run’s toCheck list', async () => {
    // Regression test: quickSearch.ts calls requestAiFilterRun() once per
    // URL card as its own search completes, so a saved search with multiple
    // source URLs triggers several separate runAiFilterAsync() calls over
    // time. A listing that streams in from a URL card finishing *after* an
    // earlier run already started must still show as pending — it must not
    // require being part of that specific run's snapshot.
    const checkedUrl = 'https://example.com/checked';
    const lateArrivalUrl = 'https://example.com/late';
    renderCardAt(checkedUrl);
    stubAiFilterStream([
      `data: {"type":"result","results":[{"url":"${checkedUrl}","pass":true,"reason":null,"relevance":7}]}\n`,
    ]);
    await runAiFilterAsync();
    await flushAnimationFrame();
    expect(getCardByUrl(checkedUrl)?.classList.contains('ai-scanning')).toBe(false);

    // A second URL card's search finishes later, streaming in a listing that
    // was never sent to this (already-completed) run.
    renderCardAt(lateArrivalUrl);
    applyClientFilters();

    expect(getCardByUrl(lateArrivalUrl)?.classList.contains('ai-scanning')).toBe(true);
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
