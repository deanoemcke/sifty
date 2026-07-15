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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network disabled in app.test.ts wiring tests'))
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
      await Promise.resolve();

      expect(aiFilterBtn.disabled).toBe(true);
      expect(aiFilterBtn.querySelector('.spinner')).not.toBeNull();

      resolveStream();
      await vi.waitFor(() => expect(aiFilterBtn.disabled).toBe(false));
      expect(aiFilterBtn.textContent).toBe('Filter');
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
      saveCurrentBtn.classList.add('hidden');

      const removeButtons = document.querySelectorAll<HTMLButtonElement>('.url-remove-btn');
      removeButtons[removeButtons.length - 1].click();

      expect(saveCurrentBtn.classList.contains('hidden')).toBe(false);
    });
  });
});
