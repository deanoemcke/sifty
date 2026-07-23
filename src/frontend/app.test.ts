// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireAllCardSearches } from './cardSearch';
import type { ListingItem } from './state';
import { loadIndexHtmlBodyFixture, makeListing, makeListingItem } from './testFixtures';

describe('fireAllCardSearches', () => {
  it('calls the search function exactly once per card', () => {
    const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const searchFn = vi.fn();
    fireAllCardSearches(cards, searchFn);
    expect(searchFn).toHaveBeenCalledTimes(3);
  });

  it('passes each card to the search function', () => {
    const cards = [{ id: 'x' }, { id: 'y' }];
    const searchFn = vi.fn();
    fireAllCardSearches(cards, searchFn);
    expect(searchFn).toHaveBeenNthCalledWith(1, cards[0]);
    expect(searchFn).toHaveBeenNthCalledWith(2, cards[1]);
  });

  it('does nothing when the card list is empty', () => {
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
vi.mock('./aiFilter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiFilter')>();
  return {
    ...actual,
    requestAiFilterRunIfPromptLongEnough: vi.fn(actual.requestAiFilterRunIfPromptLongEnough),
    requestAiFilterRun: vi.fn(actual.requestAiFilterRun),
  };
});

vi.mock('./listingDetail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./listingDetail')>();
  return { ...actual, openListingCardModal: vi.fn() };
});

vi.mock('./streamPost', () => ({
  streamPostAsync: vi.fn().mockResolvedValue(undefined),
}));

function appendListingCardFixture(): { openArea: HTMLElement; externalLink: HTMLElement } {
  const listingsContainer = document.getElementById('listingsContainer');
  if (!listingsContainer) throw new Error('#listingsContainer not found in fixture');
  const card = document.createElement('div');
  card.className = 'listing-card';
  card.dataset.url = 'https://example.com/listing/1';
  const openArea = document.createElement('div');
  openArea.className = 'listing-open-area';
  openArea.textContent = 'A vintage road bike';
  // Rendered as a sibling of .listing-open-area, never nested inside it —
  // mirrors resultsView.ts's real card markup.
  const externalLink = document.createElement('a');
  externalLink.className = 'listing-external-link-btn';
  externalLink.textContent = 'Open original';
  card.appendChild(openArea);
  card.appendChild(externalLink);
  listingsContainer.appendChild(card);
  return { openArea, externalLink };
}

function makeListingItemAt(url: string): ListingItem {
  return makeListingItem({ data: makeListing({ url, title: url, price: null, location: '' }) });
}

describe('initApp() wiring', () => {
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
    // history/localStorage persist across tests within this file (only JS
    // module state is reset by vi.resetModules()) — reset both so no test
    // leaks address-bar or draft-session state into the next one.
    history.replaceState(null, '', '/');
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network disabled in app.test.ts wiring tests'))
    );
    // markDirty()/discover-input changes now schedule a real debounced
    // draft-session save (see draftSession.ts) — fake timers by default so
    // afterEach's vi.clearAllTimers() can deterministically drop any pending
    // one, instead of it firing later against a DOM a subsequent test tore down.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // Undoes any vi.spyOn(history, ...) from the test that just ran — without
    // this, spies on native methods like history.pushState/replaceState pile
    // up across tests instead of being torn down.
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('AI filter auto-run', () => {
    it('does not run immediately, but reaches a real streamPostAsync call once the debounce interval elapses', async () => {
      vi.useFakeTimers();
      const { AI_FILTER_DEBOUNCE_MS, requestAiFilterRunIfPromptLongEnough } = await import(
        './aiFilter'
      );
      const { streamPostAsync } = await import('./streamPost');
      const { listingsByUrl } = await import('./state');
      const { urlCards, urlCardData } = await import('./urlCardStore');

      await import('./app');

      // initApp() already created one blank url card (mirroring production
      // startup) — attach the seeded listing to that real card rather than
      // pushing a second, synthetic one, which would leave urlCards with an
      // entry missing DOM handles (e.g. removeButton) and break other code
      // that iterates every card, such as updateRemoveButtons().
      const url = 'https://example.com/listing/1';
      listingsByUrl.set(url, makeListingItemAt(url));
      urlCardData(urlCards[0]).listingUrls = [url];

      const aiFilterInput = document.getElementById('aiFilter') as HTMLTextAreaElement;
      aiFilterInput.value = 'good condition only please';
      aiFilterInput.dispatchEvent(new Event('input'));

      expect(vi.mocked(requestAiFilterRunIfPromptLongEnough)).not.toHaveBeenCalled();
      expect(vi.mocked(streamPostAsync)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(AI_FILTER_DEBOUNCE_MS);

      expect(vi.mocked(requestAiFilterRunIfPromptLongEnough)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(streamPostAsync)).toHaveBeenCalledTimes(1);
      const [endpoint, body] = vi.mocked(streamPostAsync).mock.calls[0];
      expect(endpoint).toBe('/api/ai-filter');
      expect((body as { prompt: string }).prompt).toBe('good condition only please');
    });

    it('collapses rapid typing within the debounce window into a single call', async () => {
      vi.useFakeTimers();
      const { AI_FILTER_DEBOUNCE_MS, requestAiFilterRunIfPromptLongEnough } = await import(
        './aiFilter'
      );
      await import('./app');

      const aiFilterInput = document.getElementById('aiFilter') as HTMLTextAreaElement;

      aiFilterInput.value = 'good cond';
      aiFilterInput.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(AI_FILTER_DEBOUNCE_MS / 2);

      aiFilterInput.value = 'good condition, no rust';
      aiFilterInput.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(AI_FILTER_DEBOUNCE_MS / 2);

      // The first keystroke's timer should have been cancelled by the second,
      // so at 1x the debounce interval nothing has fired yet.
      expect(vi.mocked(requestAiFilterRunIfPromptLongEnough)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(AI_FILTER_DEBOUNCE_MS / 2);

      expect(vi.mocked(requestAiFilterRunIfPromptLongEnough)).toHaveBeenCalledTimes(1);
    });
  });

  describe('Enter-to-submit on discovery inputs', () => {
    it('clicks #discoveryBtn on Enter in the discovery prompt', async () => {
      await import('./app');
      const discoveryBtn = document.getElementById('discoveryBtn') as HTMLButtonElement;
      const clickSpy = vi.spyOn(discoveryBtn, 'click');
      const promptInput = document.getElementById('discoveryPrompt') as HTMLTextAreaElement;

      promptInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('clicks #discoveryBtn on Enter in the max-price input', async () => {
      await import('./app');
      const discoveryBtn = document.getElementById('discoveryBtn') as HTMLButtonElement;
      const clickSpy = vi.spyOn(discoveryBtn, 'click');
      const maxPriceInput = document.getElementById('discoveryMaxPrice') as HTMLInputElement;

      maxPriceInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('does not click #discoveryBtn on Shift+Enter (newline in the prompt)', async () => {
      await import('./app');
      const discoveryBtn = document.getElementById('discoveryBtn') as HTMLButtonElement;
      const clickSpy = vi.spyOn(discoveryBtn, 'click');
      const promptInput = document.getElementById('discoveryPrompt') as HTMLTextAreaElement;

      promptInput.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );

      expect(clickSpy).not.toHaveBeenCalled();
    });
  });

  describe('AI filter button', () => {
    it('clicks #aiFilterBtn on Enter in the AI filter textarea', async () => {
      await import('./app');
      const aiFilterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
      const clickSpy = vi.spyOn(aiFilterBtn, 'click');
      const aiFilterInput = document.getElementById('aiFilter') as HTMLTextAreaElement;

      aiFilterInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('does not click #aiFilterBtn on Shift+Enter (newline in the prompt)', async () => {
      await import('./app');
      const aiFilterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
      const clickSpy = vi.spyOn(aiFilterBtn, 'click');
      const aiFilterInput = document.getElementById('aiFilter') as HTMLTextAreaElement;

      aiFilterInput.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );

      expect(clickSpy).not.toHaveBeenCalled();
    });

    it('runs the ai filter immediately on click, bypassing the debounce/min-length guard', async () => {
      const { requestAiFilterRun } = await import('./aiFilter');
      await import('./app');

      const aiFilterInput = document.getElementById('aiFilter') as HTMLTextAreaElement;
      const aiFilterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
      // Shorter than MIN_AI_FILTER_PROMPT_LENGTH — the debounced auto-run
      // would ignore this, but an explicit click must still run it.
      aiFilterInput.value = 'old';
      aiFilterInput.dispatchEvent(new Event('input'));

      aiFilterBtn.click();

      expect(vi.mocked(requestAiFilterRun)).toHaveBeenCalledTimes(1);
    });

    it('disables the button while a run is in flight and re-enables it once done', async () => {
      const { streamPostAsync } = await import('./streamPost');
      let resolveStream: () => void = () => {};
      vi.mocked(streamPostAsync).mockReturnValue(
        new Promise((resolve) => {
          resolveStream = () => resolve(undefined);
        })
      );
      await import('./app');

      const aiFilterInput = document.getElementById('aiFilter') as HTMLTextAreaElement;
      const aiFilterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;
      aiFilterInput.value = 'good condition only please';
      aiFilterInput.dispatchEvent(new Event('input'));

      aiFilterBtn.click();
      // The run-start DOM sweep is scheduled onto the next animation frame
      // (not called directly), so a single flush is needed here — see the
      // comments in aiFilter.ts on why that call is scheduled. This describe
      // block's beforeEach already put fake timers in place.
      vi.advanceTimersByTime(20);

      expect(aiFilterBtn.disabled).toBe(true);
      expect(aiFilterBtn.querySelector('.spinner')).not.toBeNull();

      resolveStream();
      await vi.waitFor(() => expect(aiFilterBtn.disabled).toBe(false));
      expect(aiFilterBtn.textContent).toBe('Filter');
    });

    // On the mobile full-screen sheet, #aiFilterBtn is the only dismiss
    // control (no outside-tap region, no close icon — see aiFilterDropdown.ts
    // and the `≤640px` rules in styles.css). It must stay clickable even with
    // a blank prompt, or the sheet becomes stuck open: a native `disabled`
    // button never fires `click` in any browser, regardless of what the
    // handler would have done.
    it('closes the mobile sheet when tapped with a blank prompt', async () => {
      const originalMatchMedia = window.matchMedia;
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: query === '(max-width: 640px)',
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });

      const { toggleAiFilterDropdownPanel } = await import('./aiFilterDropdown');
      await import('./app');

      const aiFilterPanel = document.getElementById('aiFilterPanel') as HTMLElement;
      const aiFilterBtn = document.getElementById('aiFilterBtn') as HTMLButtonElement;

      toggleAiFilterDropdownPanel();
      expect(aiFilterPanel.classList.contains('ai-filter-panel-collapsed')).toBe(false);

      aiFilterBtn.click();

      expect(aiFilterPanel.classList.contains('ai-filter-panel-collapsed')).toBe(true);

      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: originalMatchMedia,
      });
    });
  });

  describe('Sort dropdown control', () => {
    it('populates the sort panel with all options, defaulting to source-url', async () => {
      await import('./app');
      const radios = Array.from(
        document.querySelectorAll<HTMLInputElement>('#sortDropdownOptions input[type="radio"]')
      );
      expect(radios.map((radio) => radio.value)).toEqual([
        'source-url',
        'best-match',
        'worst-match',
        'lowest-price',
        'highest-price',
      ]);
      expect(radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual([
        'source-url',
      ]);
      expect(document.querySelector('#sortDropdown .dropdown-trigger-label')?.textContent).toBe(
        'Source URL'
      );
    });

    it('updates state.sortBy, the checked radio, and the trigger label when an option changes', async () => {
      await import('./app');
      const state = await import('./state');
      const bestMatchRadio = document.getElementById('sortBestMatch') as HTMLInputElement;

      // renderDerived() schedules the non-default-sort DOM reorder via
      // requestAnimationFrame (see resultsView.ts's scheduleSortOrderUpdate).
      // Fake timers + an explicit frame-advance flush that scheduled work
      // before the test ends — otherwise it fires later against this test's
      // already-torn-down DOM and surfaces as an unhandled error.
      vi.useFakeTimers();

      bestMatchRadio.checked = true;
      bestMatchRadio.dispatchEvent(new Event('change'));

      expect(state.sortBy).toBe('best-match');
      expect((document.getElementById('sortSourceUrl') as HTMLInputElement).checked).toBe(false);
      expect(document.querySelector('#sortDropdown .dropdown-trigger-label')?.textContent).toBe(
        'Best match'
      );
      vi.advanceTimersByTime(20);
    });

    it('clicking the Sort button opens the panel and sets aria-expanded', async () => {
      await import('./app');
      const panel = document.getElementById('sortDropdownPanel') as HTMLElement;
      expect(panel.classList.contains('hidden')).toBe(true);

      document.getElementById('sortDropdownBtn')?.dispatchEvent(new Event('click'));

      expect(panel.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('sortDropdownBtn')?.getAttribute('aria-expanded')).toBe(
        'true'
      );
    });

    it('clicking the footer button closes the panel', async () => {
      await import('./app');
      document.getElementById('sortDropdownBtn')?.dispatchEvent(new Event('click'));
      document.getElementById('sortDropdownFooterBtn')?.dispatchEvent(new Event('click'));

      expect(document.getElementById('sortDropdownPanel')?.classList.contains('hidden')).toBe(true);
    });

    it('a browser-back popstate event closes the open panel', async () => {
      await import('./app');
      document.getElementById('sortDropdownBtn')?.dispatchEvent(new Event('click'));
      const panel = document.getElementById('sortDropdownPanel') as HTMLElement;
      expect(panel.classList.contains('hidden')).toBe(false);

      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(panel.classList.contains('hidden')).toBe(true);
    });
  });

  describe('Show dropdown control', () => {
    it('init populates the checkbox panel from SHOW_OPTIONS, hiding Sold and New by default', async () => {
      await import('./app');
      const checkboxIds = Array.from(
        document.querySelectorAll('#showDropdownOptions input[type="checkbox"]')
      ).map((checkbox) => checkbox.id);
      expect(checkboxIds).toEqual(['showUsed', 'showSold', 'showNew', 'showFiltered']);

      // No results yet at init, so there are no sold/new listings to show — the rows start hidden.
      expect(document.getElementById('showSoldRow')?.classList.contains('hidden')).toBe(true);
      expect(document.getElementById('showNewRow')?.classList.contains('hidden')).toBe(true);
      expect(document.querySelector('#showDropdown .dropdown-trigger-label')?.textContent).toBe(
        '0 of 0 results'
      );
    });

    it('clicking the Show button opens the panel and sets aria-expanded', async () => {
      await import('./app');
      const panel = document.getElementById('showDropdownPanel') as HTMLElement;
      expect(panel.classList.contains('hidden')).toBe(true);

      document.getElementById('showDropdownBtn')?.dispatchEvent(new Event('click'));

      expect(panel.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('showDropdownBtn')?.getAttribute('aria-expanded')).toBe(
        'true'
      );
    });

    // jsdom mirrors the browser's label activation: the label's own click
    // bubbles to the document first, then a forwarded click fires on the
    // associated button. Regression test for the external label click
    // closing-then-reopening the panel instead of toggling it closed.
    it('clicking the external Show label toggles the panel open and closed', async () => {
      await import('./app');
      const panel = document.getElementById('showDropdownPanel') as HTMLElement;
      const externalLabel = document.querySelector(
        'label[for="showDropdownBtn"]'
      ) as HTMLLabelElement;

      externalLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(panel.classList.contains('hidden')).toBe(false);

      externalLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(panel.classList.contains('hidden')).toBe(true);
    });

    it('a click outside the dropdown closes the panel', async () => {
      await import('./app');
      document
        .getElementById('showDropdownBtn')
        ?.dispatchEvent(new Event('click', { bubbles: true }));
      const panel = document.getElementById('showDropdownPanel') as HTMLElement;
      expect(panel.classList.contains('hidden')).toBe(false);

      document.body.dispatchEvent(new Event('click', { bubbles: true }));

      expect(panel.classList.contains('hidden')).toBe(true);
    });

    it('pressing Escape closes the open panel', async () => {
      await import('./app');
      document.getElementById('showDropdownBtn')?.dispatchEvent(new Event('click'));
      const panel = document.getElementById('showDropdownPanel') as HTMLElement;
      expect(panel.classList.contains('hidden')).toBe(false);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(panel.classList.contains('hidden')).toBe(true);
    });

    it('a browser-back popstate event closes the open panel', async () => {
      await import('./app');
      document.getElementById('showDropdownBtn')?.dispatchEvent(new Event('click'));
      const panel = document.getElementById('showDropdownPanel') as HTMLElement;
      expect(panel.classList.contains('hidden')).toBe(false);

      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(panel.classList.contains('hidden')).toBe(true);
    });

    it('clicking the footer button closes the panel', async () => {
      await import('./app');
      document.getElementById('showDropdownBtn')?.dispatchEvent(new Event('click'));
      document.getElementById('showDropdownFooterBtn')?.dispatchEvent(new Event('click'));

      expect(document.getElementById('showDropdownPanel')?.classList.contains('hidden')).toBe(true);
    });

    // On the mobile full-screen sheet, opening the panel pushes a history
    // marker (pushModalHistoryEntry in modalOverlay.ts) so the sheet can be
    // dismissed by consuming it via history.back() — but that marker was
    // pushed *before* the checkbox toggle below updates the address bar's
    // `show` param (syncUrlToState in app.ts's handleShowCategoryToggle).
    // Going back from it lands on the pre-open URL, which still has the old
    // `show` value. The window-level popstate listener in app.ts re-derives
    // *all* state from whatever URL it lands on (applyUrlState) for every
    // popstate — including this one — so without a fix, dismissing the sheet
    // via its own footer button silently reverts the very toggle the user
    // just made. Dropdowns are documented as "intentionally outside the URL
    // schema" (modalOverlay.ts's header comment) specifically so their own
    // history bookkeeping doesn't feed back into real app state like this.
    it('closing the mobile Show sheet via the footer button does not revert the filter toggle made while it was open', async () => {
      const originalMatchMedia = window.matchMedia;
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: query === '(max-width: 640px)',
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });

      await import('./app');
      const state = await import('./state');

      document.getElementById('showDropdownBtn')?.dispatchEvent(new Event('click'));
      const usedCheckbox = document.getElementById('showUsed') as HTMLInputElement;
      usedCheckbox.checked = false;
      usedCheckbox.dispatchEvent(new Event('change'));
      expect(state.visibleListingCategories.has('used')).toBe(false);

      // history.back() is real navigation — asynchronous even in jsdom — so
      // mock it and simulate its eventual effect ourselves, matching the
      // existing "real back navigation" tests for the listing modal above.
      const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
      document.getElementById('showDropdownFooterBtn')?.dispatchEvent(new Event('click'));
      expect(backSpy).toHaveBeenCalledTimes(1);

      // Simulate the browser having actually navigated back to the entry
      // that predates the sheet opening (no `show` param) before its
      // popstate event fires — this is what going back one step past
      // syncUrlToState's replaceState update really lands on.
      history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(state.visibleListingCategories.has('used')).toBe(false);

      // In-memory state is preserved (asserted above), but the popstate
      // landed the address bar back on '/' — the pre-open URL, which
      // predates the checkbox toggle. Reloading, copying the link, or
      // bookmarking right now must not silently lose that toggle: the
      // address bar has to be re-synced to match the state it just
      // protected, not just left wherever history.back() landed.
      expect(new URLSearchParams(location.search).get('show')).toBe('sold,new');

      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: originalMatchMedia,
      });
    });

    it('opening the Sort panel closes an open Show panel, and vice versa', async () => {
      await import('./app');
      document.getElementById('showDropdownBtn')?.dispatchEvent(new Event('click'));
      expect(document.getElementById('showDropdownPanel')?.classList.contains('hidden')).toBe(
        false
      );

      document.getElementById('sortDropdownBtn')?.dispatchEvent(new Event('click'));

      expect(document.getElementById('showDropdownPanel')?.classList.contains('hidden')).toBe(true);
      expect(document.getElementById('sortDropdownPanel')?.classList.contains('hidden')).toBe(
        false
      );
    });

    it('toggling the Sold checkbox updates state and re-applies client filters', async () => {
      await import('./app');
      const state = await import('./state');
      const soldCheckbox = document.getElementById('showSold') as HTMLInputElement;

      soldCheckbox.checked = false;
      soldCheckbox.dispatchEvent(new Event('change'));

      expect(state.visibleListingCategories.has('sold')).toBe(false);
    });

    it('the Sold row appears once results contain a sold listing, and hides again once they do not', async () => {
      const { listingsByUrl } = await import('./state');
      const { urlCards, urlCardData } = await import('./urlCardStore');
      const { renderCard, renderDerived } = await import('./resultsView');
      await import('./app');
      const soldRow = document.getElementById('showSoldRow') as HTMLElement;
      expect(soldRow.classList.contains('hidden')).toBe(true);

      const url = 'https://example.com/listing/sold-1';
      const soldItem = makeListingItemAt(url);
      soldItem.data.isSold = true;
      listingsByUrl.set(url, soldItem);
      urlCardData(urlCards[0]).listingUrls = [url];
      renderCard(soldItem);
      renderDerived();

      expect(soldRow.classList.contains('hidden')).toBe(false);

      urlCardData(urlCards[0]).listingUrls = [];
      listingsByUrl.delete(url);
      renderDerived();

      expect(soldRow.classList.contains('hidden')).toBe(true);
    });
  });

  describe('listing card open-area vs. external-link click routing', () => {
    it('opens the listing modal for a click inside the open area', async () => {
      const { openListingCardModal } = await import('./listingDetail');
      await import('./app');
      const { openArea } = appendListingCardFixture();

      openArea.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(vi.mocked(openListingCardModal)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openListingCardModal).mock.calls[0][0]).toHaveProperty(
        'className',
        'listing-card'
      );
    });

    it('does not open the modal for a click on the external-link button', async () => {
      const { openListingCardModal } = await import('./listingDetail');
      await import('./app');
      const { externalLink } = appendListingCardFixture();

      externalLink.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(vi.mocked(openListingCardModal)).not.toHaveBeenCalled();
    });
  });

  describe('saved-search dirty tracking', () => {
    it('marks the search dirty when a URL card is removed', async () => {
      // jsdom doesn't implement scrollIntoView; addUrlBtn's click handler calls it.
      Element.prototype.scrollIntoView = vi.fn();
      await import('./app');
      const saveCurrentBtn = document.getElementById('saveCurrentBtn') as HTMLButtonElement;
      const addUrlBtn = document.getElementById('addUrlBtn') as HTMLButtonElement;
      // initApp() seeds one blank card; add a second so a remove button is shown.
      addUrlBtn.click();
      // Simulate a clean session (as if a favourite had just been loaded) —
      // adding the card itself also marks dirty, which isn't what's under test.
      saveCurrentBtn.disabled = true;

      const removeButtons = document.querySelectorAll<HTMLButtonElement>('.url-remove-btn');
      removeButtons[removeButtons.length - 1].click();

      expect(saveCurrentBtn.disabled).toBe(false);
    });
  });

  describe('URL state / browser history integration', () => {
    it('switching to the Favourites tab pushes ?tab=favourites; switching back removes it', async () => {
      await import('./app');
      document.getElementById('favouritesTabBtn')?.dispatchEvent(new Event('click'));
      expect(new URLSearchParams(location.search).get('tab')).toBe('favourites');

      document.getElementById('searchTabBtn')?.dispatchEvent(new Event('click'));
      expect(new URLSearchParams(location.search).get('tab')).toBe(null);
    });

    it('switching tabs pushes a real history entry (not just a replace)', async () => {
      await import('./app');
      await vi.advanceTimersByTimeAsync(0);
      const pushSpy = vi.spyOn(history, 'pushState');
      const replaceSpy = vi.spyOn(history, 'replaceState');

      document.getElementById('favouritesTabBtn')?.dispatchEvent(new Event('click'));

      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(replaceSpy).not.toHaveBeenCalled();
    });

    it('clicking the already-active tab is a no-op: no history push and no replace', async () => {
      await import('./app');
      await vi.advanceTimersByTimeAsync(0);
      const pushSpy = vi.spyOn(history, 'pushState');
      const replaceSpy = vi.spyOn(history, 'replaceState');

      // Search is the default active tab, so clicking it again should not
      // touch history at all — not even a replace.
      document.getElementById('searchTabBtn')?.dispatchEvent(new Event('click'));

      expect(pushSpy).not.toHaveBeenCalled();
      expect(replaceSpy).not.toHaveBeenCalled();
    });

    it('changing the sort option replaces the URL rather than pushing a new entry', async () => {
      await import('./app');
      // Let the fire-and-forget boot-time applyUrlState/syncUrlToState chain
      // (which also calls replaceState once) settle before counting calls.
      await vi.advanceTimersByTimeAsync(0);
      vi.useFakeTimers();
      const pushSpy = vi.spyOn(history, 'pushState');
      const replaceSpy = vi.spyOn(history, 'replaceState');

      const bestMatchRadio = document.getElementById('sortBestMatch') as HTMLInputElement;
      bestMatchRadio.checked = true;
      bestMatchRadio.dispatchEvent(new Event('change'));

      expect(new URLSearchParams(location.search).get('sort')).toBe('best-match');
      expect(pushSpy).not.toHaveBeenCalled();
      expect(replaceSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(20);
    });

    it('toggling a Show filter replaces the URL rather than pushing a new entry', async () => {
      await import('./app');
      await vi.advanceTimersByTimeAsync(0);
      const pushSpy = vi.spyOn(history, 'pushState');
      const replaceSpy = vi.spyOn(history, 'replaceState');

      const soldCheckbox = document.getElementById('showSold') as HTMLInputElement;
      soldCheckbox.checked = false;
      soldCheckbox.dispatchEvent(new Event('change'));

      expect(new URLSearchParams(location.search).get('show')).toBe('used,new');
      expect(pushSpy).not.toHaveBeenCalled();
      expect(replaceSpy).toHaveBeenCalledTimes(1);
    });

    it('submitting the discovery form after a saved search was loaded pushes a new entry, preserving the saved search as a back-stop', async () => {
      await import('./app');
      await vi.advanceTimersByTimeAsync(0);

      const state = await import('./state');
      state.setCurrentSearchId('abc');
      history.replaceState(null, '', '/?search=abc');

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ urls: ['https://example.com/x'], name: 'New search' }),
        })
      );

      const promptInput = document.getElementById('discoveryPrompt') as HTMLTextAreaElement;
      promptInput.value = 'lamp';
      promptInput.dispatchEvent(new Event('input'));

      const pushSpy = vi.spyOn(history, 'pushState');
      const replaceSpy = vi.spyOn(history, 'replaceState');

      document.getElementById('discoveryBtn')?.dispatchEvent(new Event('click'));
      await vi.advanceTimersByTimeAsync(0);

      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(replaceSpy).not.toHaveBeenCalled();
      expect(new URLSearchParams(location.search).get('search')).toBe(null);
    });

    it('opening a listing card modal pushes a new history entry', async () => {
      await import('./app');
      await vi.advanceTimersByTimeAsync(0);
      const { openArea } = appendListingCardFixture();
      const pushSpy = vi.spyOn(history, 'pushState');

      openArea.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it('closing a modal this session opened calls history.back() to consume the pushed entry', async () => {
      await import('./app');
      await vi.advanceTimersByTimeAsync(0);
      const { openListingCardModal } = await import('./listingDetail');
      const stateModule = await import('./state');
      // openListingCardModal is stubbed for this file — simulate what it
      // would really have done to state on open.
      vi.mocked(openListingCardModal).mockImplementation(() => {
        stateModule.setOpenModalListingUrl('https://example.com/listing/1');
      });
      const { openArea } = appendListingCardFixture();
      openArea.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
      document.getElementById('listingModalCloseBtn')?.dispatchEvent(new Event('click'));

      expect(backSpy).toHaveBeenCalledTimes(1);
    });

    it('closing a modal opened by a boot-time deep link (never pushed by this session) replaces the URL instead of calling history.back()', async () => {
      const { listingsByUrl } = await import('./state');
      const url = 'https://example.com/listing/1';
      listingsByUrl.set(url, makeListingItemAt(url));
      // Simulate arriving via a shared/bookmarked link that already contains
      // the modal param — a real browser navigation, never pushState, so
      // history.state carries no siftyPushed marker for this entry.
      history.replaceState(null, '', `/?modal=${encodeURIComponent(url)}`);

      await import('./app');
      await vi.waitFor(() => {
        expect(document.getElementById('listingModal')?.classList.contains('hidden')).toBe(false);
      });

      const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
      document.getElementById('listingModalCloseBtn')?.dispatchEvent(new Event('click'));

      expect(backSpy).not.toHaveBeenCalled();
      expect(new URLSearchParams(location.search).get('modal')).toBe(null);
    });

    it('a real back navigation past an open modal closes it without calling history.back() again', async () => {
      await import('./app');
      const { openListingCardModal } = await import('./listingDetail');
      const stateModule = await import('./state');
      // openListingCardModal is stubbed for this file — simulate what it
      // would really have done to state on open.
      vi.mocked(openListingCardModal).mockImplementation(() => {
        stateModule.setOpenModalListingUrl('https://example.com/listing/1');
      });
      const { openArea } = appendListingCardFixture();
      openArea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Simulate the browser having already navigated back to the entry that
      // predates the modal (no modal param) — that's what a real back-button
      // press does before the popstate event ever fires.
      history.replaceState(null, '', '/');

      const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(backSpy).not.toHaveBeenCalled();
    });

    it('a popstate event re-applies tab/sort/show from the current URL', async () => {
      await import('./app');
      history.pushState(null, '', '/?tab=favourites&sort=lowest-price&show=used');

      window.dispatchEvent(new PopStateEvent('popstate'));

      const state = await import('./state');
      expect(state.activeSidebarTab).toBe('favourites');
      expect(state.sortBy).toBe('lowest-price');
      expect([...state.visibleListingCategories]).toEqual(['used']);
      expect(document.getElementById('savedSearchesPanel')?.classList.contains('hidden')).toBe(
        false
      );
    });

    it('an older popstate’s saved-search fetch resolving after a newer one does not overwrite the newer state', async () => {
      await import('./app');
      await vi.advanceTimersByTimeAsync(0);

      const savedSearchA = {
        id: 'aaa',
        name: 'Search A',
        urls: ['https://example.com/a'],
        aiFilter: null,
        createdAt: 0,
        shouldAlertOnNewListings: false,
      };
      const savedSearchB = {
        id: 'bbb',
        name: 'Search B',
        urls: ['https://example.com/b'],
        aiFilter: null,
        createdAt: 0,
        shouldAlertOnNewListings: false,
      };

      let resolveFetchA!: (value: unknown) => void;
      let resolveFetchB!: (value: unknown) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const url = String(input);
          if (url === '/api/saved-searches/aaa') {
            return new Promise((resolve) => {
              resolveFetchA = resolve;
            });
          }
          if (url === '/api/saved-searches/bbb') {
            return new Promise((resolve) => {
              resolveFetchB = resolve;
            });
          }
          return Promise.reject(new Error(`unexpected fetch: ${url}`));
        })
      );

      // Rapid back/forward: the popstate for "aaa" is still awaiting its
      // saved-search fetch when the popstate for "bbb" fires.
      history.pushState(null, '', '/?search=aaa');
      window.dispatchEvent(new PopStateEvent('popstate'));
      history.pushState(null, '', '/?search=bbb');
      window.dispatchEvent(new PopStateEvent('popstate'));

      // The newer request ("bbb") resolves first, as it would in the
      // ordinary (non-adversarial) case.
      resolveFetchB({ ok: true, json: async () => ({ search: savedSearchB }) });
      await vi.advanceTimersByTimeAsync(0);

      const { urlCards } = await import('./urlCardStore');
      expect(urlCards[0].dom.input.value).toBe('https://example.com/b');

      // The older, now-superseded request ("aaa") resolves late — its
      // result must be discarded rather than clobbering "bbb".
      resolveFetchA({ ok: true, json: async () => ({ search: savedSearchA }) });
      await vi.advanceTimersByTimeAsync(0);

      const state = await import('./state');
      expect(state.currentSearchId).toBe('bbb');
      expect(urlCards[0].dom.input.value).toBe('https://example.com/b');
    });

    it('booting with a malformed query string applies defaults and self-corrects the address bar', async () => {
      history.pushState(null, '', '/?sort=bogus&show=nonsense&tab=bogus');

      await import('./app');
      await vi.waitFor(() => {
        expect(new URLSearchParams(location.search).get('sort')).toBe(null);
      });

      const state = await import('./state');
      expect(state.sortBy).toBe('source-url');
      expect(state.activeSidebarTab).toBe('search');
      expect([...state.visibleListingCategories].sort()).toEqual(['new', 'sold', 'used'].sort());
      expect(new URLSearchParams(location.search).get('show')).toBe(null);
      expect(new URLSearchParams(location.search).get('tab')).toBe(null);
    });

    it('editing a discover-form field schedules a debounced draft-session save', async () => {
      await import('./app');
      vi.useFakeTimers();
      const { loadDraftSession } = await import('./draftSession');

      const promptInput = document.getElementById('discoveryPrompt') as HTMLTextAreaElement;
      promptInput.value = 'lamp';
      promptInput.dispatchEvent(new Event('input'));

      expect(loadDraftSession()).toBe(null);
      vi.runAllTimers();
      expect(loadDraftSession()).not.toBe(null);
    });
  });
});
