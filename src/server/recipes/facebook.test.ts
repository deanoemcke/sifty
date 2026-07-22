import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCooldownStore } from '../../lib/recipes/base';
import { makeListing } from '../../lib/testFixtures';
import { aiJSON } from '../ai';
import {
  buildFacebookDeepSearchDetail,
  buildFacebookListing,
  buildFacebookPhotosFromUrls,
  buildFacebookSearchQueryAsync,
  buildFacebookUrl,
  classifyInitialSearchStateAsync,
  deriveFacebookDescriptionAndLocation,
  detectLoginWallAsync,
  extractFacebookDetailsCardData,
  extractFacebookPhotoUrls,
  extractImplicitFilters,
  type FacebookDetailsCardData,
  facebookRecipe,
  fetchFacebookListingDetailAsync,
  installNameShim,
  isEmptyResultsText,
  isLoginWallText,
  isLoginWallUrl,
  MissingFacebookCookiesError,
  parseFacebookPriceLines,
  parseFbCookies,
  processRawListing,
  type RawListingMsg,
} from './facebook';

describe('facebookRecipe.computeAlertFingerprint', () => {
  it('differs when the price differs — Facebook Marketplace is fixed-price, so this is safe', () => {
    const a = makeListing({ source: 'facebook', price: 50 });
    const b = makeListing({ source: 'facebook', price: 75 });
    expect(facebookRecipe.computeAlertFingerprint(a)).not.toBe(
      facebookRecipe.computeAlertFingerprint(b)
    );
  });

  it('is the same for a listing relisted under a different URL id', () => {
    const original = makeListing({
      source: 'facebook',
      url: 'https://example.com/marketplace/item/111',
    });
    const relisted = makeListing({
      source: 'facebook',
      url: 'https://example.com/marketplace/item/999',
    });
    expect(facebookRecipe.computeAlertFingerprint(original)).toBe(
      facebookRecipe.computeAlertFingerprint(relisted)
    );
  });

  it('ignores the URL entirely', () => {
    const a = makeListing({
      source: 'facebook',
      url: 'https://trademe.co.nz/a/marketplace/for-sale/listing/1',
    });
    const b = makeListing({ source: 'facebook', url: 'https://facebook.com/marketplace/item/999' });
    expect(facebookRecipe.computeAlertFingerprint(a)).toBe(
      facebookRecipe.computeAlertFingerprint(b)
    );
  });
});

describe('installNameShim', () => {
  afterEach(() => {
    delete (globalThis as { __name?: unknown }).__name;
  });

  it('defines a passthrough __name so an esbuild-injected __name(fn, "fn") call resolves', () => {
    installNameShim();
    const marker = () => 'marker';
    expect((globalThis as { __name?: (fn: unknown) => unknown }).__name?.(marker)).toBe(marker);
  });

  it('does not clobber an existing __name', () => {
    const sentinel = () => 'sentinel';
    (globalThis as { __name?: unknown }).__name = sentinel;
    installNameShim();
    expect((globalThis as { __name?: unknown }).__name).toBe(sentinel);
  });
});

const TEST_REGIONS = [
  { name: 'Auckland', tradeMeRegionId: 2, facebookLocation: 'auckland' },
  { name: 'Wellington', tradeMeRegionId: 12, facebookLocation: 'wellington' },
];

// This mock is load-bearing for buildDiscoverUrlsAsync tests below, which rely on
// buildFacebookUrl's default `regions` argument being supplied by the mocked getRegions.
vi.mock('../services/regions', () => ({ getRegions: () => TEST_REGIONS }));
// `applyAiJsonResult` is left as the real implementation (not mocked) so these tests
// exercise the actual orchestration logic — unwrapping an ok result, or marking the
// cooldown store and throwing for a rate-limited one — with only `aiJSON` faked.
vi.mock('../ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai')>();
  return { ...actual, aiJSON: vi.fn() };
});

// ── Playwright mock for quickSearchAsync / deepSearchAsync integration tests ──
//
// This is a duck-typed stand-in, not the real Playwright `Page` — same convention
// as trademe.test.ts's mock. `evaluate` distinguishes the login-wall detector's
// callback (identified by its source containing "login_popup_cta_form") from every
// other `page.evaluate(...)` call site (MutationObserver injection, body-text
// extraction), which all just need a plain string back.
//
// Deliberately NOT imported from facebook.ts: keeping an independent literal here
// means an accidental change to the production selector fails this suite loudly,
// instead of the mock silently tracking whatever the source now exports.
const LISTINGS_SELECTOR_IN_TEST = 'a[href*="/marketplace/item/"]';
type FacebookPageOptions = {
  url?: string;
  domLoginWall?: boolean;
  textSnippet?: string;
  listingsSelectorTimesOut?: boolean;
  listingsAppearOnRetry?: boolean;
  emptyStateAppears?: boolean;
  shellRendered?: boolean;
  cookieBannerVisible?: boolean;
  bodyText?: string;
  detailsCardData?: FacebookDetailsCardData | null;
  photoUrls?: string[];
};

const { getNextPage, resetPageQueue, makeFacebookPage, browserSessionTracker } = vi.hoisted(() => {
  const queue: unknown[] = [];

  // Tracks how many mocked Chromium instances are live at once, so tests can
  // assert that concurrent searches do (or don't) stack browser sessions.
  const browserSessionTracker = {
    activeCount: 0,
    maxActiveCount: 0,
    reset() {
      this.activeCount = 0;
      this.maxActiveCount = 0;
    },
  };

  function makeFacebookPage(options: FacebookPageOptions = {}) {
    const {
      url = 'https://www.facebook.com/marketplace/search?query=lamp',
      domLoginWall = false,
      textSnippet = '',
      listingsSelectorTimesOut = false,
      listingsAppearOnRetry = false,
      emptyStateAppears = false,
      shellRendered = false,
      cookieBannerVisible = false,
      bodyText = '',
      detailsCardData = null,
      photoUrls = [],
    } = options;

    const waitForSelectorCalls: string[] = [];
    const wheelCalls = { count: 0 };
    const listingsSelectorAttemptCounts = { count: 0 };
    const waitForTimeoutCalls: number[] = [];

    return {
      goto: async () => {},
      url: () => url,
      addInitScript: async () => {},
      exposeFunction: async () => {},
      locator: () => ({
        first: () => ({
          isVisible: async () => cookieBannerVisible,
          click: async () => {},
        }),
      }),
      getByRole: () => ({
        first: () => ({
          isVisible: async () => false,
          click: async () => {},
        }),
      }),
      waitForTimeout: async (ms: number) => {
        waitForTimeoutCalls.push(ms);
      },
      waitForSelector: async (selector: string) => {
        waitForSelectorCalls.push(selector);
        // Model page state ("listings selector starts matching after N asks"),
        // keyed on the selector actually requested — not on the position of this
        // call among all waitForSelector calls of any kind. A future unrelated
        // waitForSelector (e.g. for the Marketplace shell) must not shift which
        // call this mock treats as the listings grace re-check.
        if (selector !== LISTINGS_SELECTOR_IN_TEST) return;
        listingsSelectorAttemptCounts.count++;
        const isRetryAttempt = listingsSelectorAttemptCounts.count > 1;
        if (listingsSelectorTimesOut && !(listingsAppearOnRetry && isRetryAttempt))
          throw new Error('timeout');
      },
      // Stands in for the empty-state marker wait: resolves when the mocked page
      // "renders" the empty-state, rejects (as a Playwright timeout would) otherwise.
      waitForFunction: async () => {
        if (!emptyStateAppears) throw new Error('timeout');
      },
      evaluate: async (fn: (...args: unknown[]) => unknown) => {
        if (fn.toString().includes('login_popup_cta_form')) {
          return { domMatch: domLoginWall, textSnippet };
        }
        if (fn.toString().includes('shellRendered')) {
          return { shellRendered, bodyText };
        }
        if (fn.name === 'extractFacebookDetailsCardData') {
          return detailsCardData;
        }
        if (fn.name === 'extractFacebookPhotoUrls') {
          return photoUrls;
        }
        return bodyText;
      },
      mouse: {
        wheel: async () => {
          wheelCalls.count++;
        },
      },
      keyboard: { press: async () => {} },
      close: async () => {},
      waitForSelectorCalls,
      wheelCalls,
      waitForTimeoutCalls,
    };
  }

  return {
    getNextPage: (): ReturnType<typeof makeFacebookPage> =>
      (queue.shift() as ReturnType<typeof makeFacebookPage>) ?? makeFacebookPage(),
    resetPageQueue: (...items: unknown[]) => queue.splice(0, queue.length, ...items),
    makeFacebookPage,
    browserSessionTracker,
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
      browserSessionTracker.activeCount++;
      browserSessionTracker.maxActiveCount = Math.max(
        browserSessionTracker.maxActiveCount,
        browserSessionTracker.activeCount
      );
      return {
        newContext: async () => ({
          newPage: async () => getNextPage(),
          addCookies: async () => {},
          close: async () => {},
        }),
        close: async () => {
          browserSessionTracker.activeCount--;
        },
        isConnected: () => true,
      };
    },
  },
}));

// The real `enqueue` limits per-domain concurrency (facebook.com = 2). This mock
// serializes every task (concurrency 1) and records each URL, so tests can
// observe behaviourally that a code path is routed through the limiter — a
// plain passthrough would make a bypassed limiter indistinguishable from a
// working one.
const { enqueuedUrls, serializingEnqueue } = vi.hoisted(() => {
  const enqueuedUrls: string[] = [];
  let chainTail: Promise<unknown> = Promise.resolve();
  function serializingEnqueue<T>(url: string, asyncTask: () => Promise<T>): Promise<T> {
    enqueuedUrls.push(url);
    const result = chainTail.then(asyncTask);
    chainTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  return { enqueuedUrls, serializingEnqueue };
});

vi.mock('../../lib/queue', () => ({ enqueue: serializingEnqueue }));

const VALID_FB_COOKIES = JSON.stringify([{ name: 'c_user', value: '12345' }]);

const STUB_COOLDOWN_STORE: ProviderCooldownStore = {
  markExhausted: () => {},
  getCooldownUntil: () => undefined,
};

const MOCK_AI_CONFIG = {
  url: 'http://example.com',
  model: 'llama',
  apiKey: 'key',
  providerKey: 'mock',
  cooldownStore: STUB_COOLDOWN_STORE,
};

// aiJSON is mocked wholesale in this file, so its calls must resolve with the
// `AiJsonResult` shape (`{ kind: "ok", value }`) that the real function now
// returns — see src/server/ai.ts. `applyAiJsonResult` itself is NOT mocked
// (see the `vi.mock("../ai", ...)` above), so these tests exercise the real
// unwrap/mark/throw orchestration logic against a faked aiJSON.
function aiJsonOk(value: unknown) {
  return { kind: 'ok' as const, value };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('extractImplicitFilters', () => {
  it('extracts the search query without quote marks', () => {
    const url = 'https://www.facebook.com/marketplace/wellington/search?query=pole%20trimmer';
    const filters = extractImplicitFilters(url);
    expect(filters).toContainEqual(['Search', 'pole trimmer']);
  });

  it('shows Availability: SOLD for a sold-items search (availability=out of stock)', () => {
    const url =
      'https://www.facebook.com/marketplace/wellington/search?query=pole%20trimmer&availability=out%20of%20stock';
    const filters = extractImplicitFilters(url);
    expect(filters).toContainEqual(['Availability', 'SOLD']);
  });

  it('omits Availability for a normal (non-sold) search', () => {
    const url = 'https://www.facebook.com/marketplace/wellington/search?query=pole%20trimmer';
    const filters = extractImplicitFilters(url);
    expect(filters.map(([key]) => key)).not.toContain('Availability');
  });
});

describe('parseFacebookPriceLines', () => {
  it('returns the single price when only one price line is present', () => {
    const result = parseFacebookPriceLines('Vintage lamp\nNZ$80\nAuckland');
    expect(result.price).toBe(80);
  });

  it('uses only the current price when two prices are present, discarding the original', () => {
    // Facebook shows the sale price first and the original price second.
    // Product decision: we surface only the current price; the original is not stored or displayed.
    const result = parseFacebookPriceLines('Nice chair\nNZ$80\nNZ$120\nWellington');
    expect(result.price).toBe(80);
  });

  it('returns null price when no price is present', () => {
    const result = parseFacebookPriceLines('Mystery item\nAuckland');
    expect(result.price).toBeNull();
  });

  it('returns 0 price for Free', () => {
    const result = parseFacebookPriceLines('Free sofa\nFree\nChristchurch');
    expect(result.price).toBe(0);
  });

  it('parses prices with commas', () => {
    const result = parseFacebookPriceLines('Car\nNZ$1,200\nDunedin');
    expect(result.price).toBe(1200);
  });

  it('handles empty innerText gracefully', () => {
    const result = parseFacebookPriceLines('');
    expect(result.price).toBeNull();
  });

  it('handles whitespace-only innerText gracefully', () => {
    const result = parseFacebookPriceLines('  \n  \n  ');
    expect(result.price).toBeNull();
  });

  it('returns normalised lines for caller reuse', () => {
    const result = parseFacebookPriceLines('Vintage lamp\nNZ$80\nAuckland');
    expect(result.lines).toEqual(['Vintage lamp', 'NZ$80', 'Auckland']);
  });

  it('returns isSold: false for a normal listing', () => {
    const result = parseFacebookPriceLines('Vintage lamp\nNZ$80\nAuckland');
    expect(result.isSold).toBe(false);
  });

  it('returns isSold: true and strips the status/separator lines for a "Sold" listing', () => {
    // Real captured innerText: the status word, the "·" separator, and the price
    // each render as separate flex items, i.e. separate lines — not one combined
    // "Sold · NZ$100" line.
    const result = parseFacebookPriceLines(
      'Sold\n·\nNZ$100\nMacBook Air 2015\nTitahi Bay, New Zealand'
    );
    expect(result.isSold).toBe(true);
    expect(result.price).toBe(100);
    expect(result.lines).toEqual(['NZ$100', 'MacBook Air 2015', 'Titahi Bay, New Zealand']);
  });

  it('returns isSold: true and strips the status/separator lines for a "Pending" listing', () => {
    const result = parseFacebookPriceLines('Pending\n·\nNZ$50\nOld chair\nTitahi Bay');
    expect(result.isSold).toBe(true);
    expect(result.price).toBe(50);
    expect(result.lines).toEqual(['NZ$50', 'Old chair', 'Titahi Bay']);
  });

  it('does not treat a title merely containing the word "sold" as isSold', () => {
    const result = parseFacebookPriceLines('Sold as-is toolbox\nNZ$40\nHamilton');
    expect(result.isSold).toBe(false);
    expect(result.price).toBe(40);
  });

  it('does not treat a title line that is literally "Sold" (no adjacent separator) as isSold', () => {
    // The real sold/pending marker is always immediately followed by the "·"
    // separator line. A bare "Sold" title must not be misclassified, and must
    // stay in the line pool so the title/location fallback still sees it.
    const result = parseFacebookPriceLines('Sold\nNZ$40\nHamilton');
    expect(result.isSold).toBe(false);
    expect(result.price).toBe(40);
    expect(result.lines).toEqual(['Sold', 'NZ$40', 'Hamilton']);
  });

  it('does not treat a location line that is literally "Pending" as isSold', () => {
    const result = parseFacebookPriceLines('Antique desk\nNZ$120\nPending');
    expect(result.isSold).toBe(false);
    expect(result.price).toBe(120);
    expect(result.lines).toEqual(['Antique desk', 'NZ$120', 'Pending']);
  });

  it('strips only the adjacent status/separator pair when a sold listing also has a status-like title', () => {
    const result = parseFacebookPriceLines('Pending\n·\nNZ$50\nSold\nTitahi Bay');
    expect(result.isSold).toBe(true);
    expect(result.price).toBe(50);
    expect(result.lines).toEqual(['NZ$50', 'Sold', 'Titahi Bay']);
  });

  it('falls back to parsing a combined "Sold · NZ$50" single-line shape', () => {
    // If Facebook ever renders the status row as one line instead of three
    // flex-item lines, the combined shape must still be recognised.
    const result = parseFacebookPriceLines('Sold · NZ$50\nOld chair\nTitahi Bay');
    expect(result.isSold).toBe(true);
    expect(result.price).toBe(50);
    expect(result.lines).toEqual(['NZ$50', 'Old chair', 'Titahi Bay']);
  });

  it('falls back to parsing a combined "Pending · Free" single-line shape', () => {
    const result = parseFacebookPriceLines('Pending · Free\nOld chair\nTitahi Bay');
    expect(result.isSold).toBe(true);
    expect(result.price).toBe(0);
    expect(result.lines).toEqual(['Free', 'Old chair', 'Titahi Bay']);
  });

  it('warns and keeps the remainder when a combined status line has an unparseable price', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = parseFacebookPriceLines('Sold · about $50 ono\nOld chair\nTitahi Bay');
      expect(result.isSold).toBe(true);
      expect(result.price).toBeNull();
      expect(result.lines).toEqual(['about $50 ono', 'Old chair', 'Titahi Bay']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[facebook]'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not treat a title containing "·" without a status prefix as isSold', () => {
    const result = parseFacebookPriceLines('Table · solid rimu\nNZ$40\nHamilton');
    expect(result.isSold).toBe(false);
    expect(result.price).toBe(40);
    expect(result.lines).toEqual(['Table · solid rimu', 'NZ$40', 'Hamilton']);
  });
});

// ── buildFacebookUrl ──────────────────────────────────────────────────────────

describe('buildFacebookUrl', () => {
  it('always sets query, exact, and sortBy', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).toContain('query=macbook');
    expect(url).toContain('exact=false');
    expect(url).toContain('sortBy=creation_time_descend');
  });

  it('adds maxPrice when > 0', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 800,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).toContain('maxPrice=800');
  });

  it('omits maxPrice when 0', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).not.toContain('maxPrice');
  });

  it('sets deliveryMethod=local_pick_up for pickup fulfillment', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'pickup',
      regionValue: undefined,
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).toContain('deliveryMethod=local_pick_up');
  });

  it('sets deliveryMethod=shipping for shipping fulfillment', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'shipping',
      regionValue: undefined,
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).toContain('deliveryMethod=shipping');
  });

  it('omits deliveryMethod for "any" fulfillment', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).not.toContain('deliveryMethod');
  });

  it('injects location segment when pickup and regionValue matches a region', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'pickup',
      regionValue: '2',
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).toContain('/marketplace/auckland/search');
  });

  it('omits location segment when pickup but regionValue is undefined', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'pickup',
      regionValue: undefined,
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).toContain('/marketplace/search');
    expect(url).not.toContain('/marketplace/auckland/');
  });

  it('omits location segment when fulfillment is "any" even with regionValue', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'any',
      regionValue: '2',
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).not.toContain('/marketplace/auckland/');
  });

  it('omits location segment when regionValue does not match any region', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'pickup',
      regionValue: '999',
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).toContain('/marketplace/search');
    expect(url).not.toContain('/marketplace/undefined/');
  });

  it('adds availability=out of stock when includeSoldItems is true', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: true,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(new URL(url).searchParams.get('availability')).toBe('out of stock');
  });

  it('omits maxPrice when includeSoldItems is true even if maxPrice > 0', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 800,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: true,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).not.toContain('maxPrice');
  });

  it('omits deliveryMethod when includeSoldItems is true even for pickup fulfillment', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'pickup',
      regionValue: undefined,
      includeSoldItems: true,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).not.toContain('deliveryMethod');
  });

  it('omits deliveryMethod when includeSoldItems is true even for shipping fulfillment', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'shipping',
      regionValue: undefined,
      includeSoldItems: true,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).not.toContain('deliveryMethod');
  });

  it('omits location segment when includeSoldItems is true even for pickup with a matching region', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'pickup',
      regionValue: '2',
      includeSoldItems: true,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).not.toContain('/marketplace/auckland/');
    expect(url).toContain('/marketplace/search');
  });

  it('still sets query, exact, and sortBy when includeSoldItems is true', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: true,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(url).toContain('query=macbook');
    expect(url).toContain('exact=false');
    expect(url).toContain('sortBy=creation_time_descend');
  });

  it('sets itemCondition=used_like_new,used_good,used_fair when condition is "used"', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: false,
      condition: 'used',
      regions: TEST_REGIONS,
    });
    expect(new URL(url).searchParams.get('itemCondition')).toBe(
      'used_like_new,used_good,used_fair'
    );
  });

  it('sets itemCondition=new when condition is "new"', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: false,
      condition: 'new',
      regions: TEST_REGIONS,
    });
    expect(new URL(url).searchParams.get('itemCondition')).toBe('new');
  });

  it('omits itemCondition when includeSoldItems is true, regardless of condition', () => {
    const url = buildFacebookUrl({
      searchTerm: 'macbook',
      maxPrice: 0,
      fulfillment: 'any',
      regionValue: undefined,
      includeSoldItems: true,
      condition: 'new',
      regions: TEST_REGIONS,
    });
    expect(url).not.toContain('itemCondition');
  });
});

// ── buildFacebookSearchQueryAsync ─────────────────────────────────────────────

describe('buildFacebookSearchQueryAsync', () => {
  it('returns the AI-extracted keyword query', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await buildFacebookSearchQueryAsync(
      "I'm looking for a MacBook Pro from 2019",
      MOCK_AI_CONFIG
    );
    expect(result).toBe('macbook pro');
  });

  it('trims whitespace from the AI-returned query', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: '  macbook pro  ' }));
    const result = await buildFacebookSearchQueryAsync('macbook pro laptop', MOCK_AI_CONFIG);
    expect(result).toBe('macbook pro');
  });

  it('passes the trimmed prompt to the AI', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    await buildFacebookSearchQueryAsync('  macbook pro  ', MOCK_AI_CONFIG);
    expect(vi.mocked(aiJSON)).toHaveBeenCalledWith(
      MOCK_AI_CONFIG,
      'facebook:query',
      expect.any(String),
      'macbook pro',
      64
    );
  });

  it('throws when AI returns null', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk(null));
    await expect(buildFacebookSearchQueryAsync('macbook pro', MOCK_AI_CONFIG)).rejects.toThrow();
  });

  it('throws when AI returns an object with no query field', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ keywords: 'macbook pro' }));
    await expect(buildFacebookSearchQueryAsync('macbook pro', MOCK_AI_CONFIG)).rejects.toThrow();
  });

  it('throws when AI returns an empty query string', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: '' }));
    await expect(buildFacebookSearchQueryAsync('macbook pro', MOCK_AI_CONFIG)).rejects.toThrow();
  });

  it('throws when AI returns a whitespace-only query string', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: '   ' }));
    await expect(buildFacebookSearchQueryAsync('macbook pro', MOCK_AI_CONFIG)).rejects.toThrow();
  });

  it('propagates AI errors', async () => {
    vi.mocked(aiJSON).mockRejectedValueOnce(new Error('Rate limited'));
    await expect(buildFacebookSearchQueryAsync('macbook pro', MOCK_AI_CONFIG)).rejects.toThrow(
      'Rate limited'
    );
  });

  it("marks the config's cooldown store exhausted and propagates the error when AI is rate-limited", async () => {
    const markExhausted = vi.fn();
    const rateLimitedAiConfig = {
      ...MOCK_AI_CONFIG,
      cooldownStore: { markExhausted, getCooldownUntil: () => undefined },
    };
    const cooldownUntilMs = Date.now() + 60_000;
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: 'rate-limited',
      providerKey: 'mock',
      cooldownUntilMs,
      message: 'AI rate limited (facebook:query): provider asks to retry',
    });

    await expect(buildFacebookSearchQueryAsync('macbook pro', rateLimitedAiConfig)).rejects.toThrow(
      'AI rate limited (facebook:query)'
    );

    expect(markExhausted).toHaveBeenCalledWith('mock', cooldownUntilMs);
  });
});

// ── buildDiscoverUrlsAsync ────────────────────────────────────────────────────

describe('buildDiscoverUrlsAsync', () => {
  it('returns a single Facebook Marketplace URL', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('macbook pro', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain('facebook.com/marketplace');
  });

  it('uses the AI-extracted query in the search URL', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync(
      "I'm looking for a MacBook Pro laptop in good condition",
      {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI_CONFIG,
      }
    );
    expect(result.urls[0]).toContain('query=macbook+pro');
  });

  it('includes maxPrice when > 0', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'laptop' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 500,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls[0]).toContain('maxPrice=500');
  });

  it('injects region location segment when pickup fulfillment and matching region', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'laptop' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'pickup',
      includeSoldItems: false,
      includeNewItems: false,
      regionValue: '2',
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls[0]).toContain('/marketplace/auckland/search');
  });

  it('returns an empty warnings array', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('macbook pro', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.warnings).toEqual([]);
  });

  it('passes the trimmed prompt to the AI', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    await facebookRecipe.buildDiscoverUrlsAsync('  macbook pro  ', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(vi.mocked(aiJSON)).toHaveBeenCalledWith(
      MOCK_AI_CONFIG,
      'facebook:query',
      expect.any(String),
      'macbook pro',
      64
    );
  });

  it('propagates AI errors without fallback', async () => {
    vi.mocked(aiJSON).mockRejectedValueOnce(new Error('AI unavailable'));
    await expect(
      facebookRecipe.buildDiscoverUrlsAsync('macbook pro', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI_CONFIG,
      })
    ).rejects.toThrow('AI unavailable');
  });

  it('adds a second sold-items URL when includeSoldItems is true', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('macbook pro', {
      maxPrice: 500,
      fulfillment: 'pickup',
      regionValue: '2',
      includeSoldItems: true,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls).toHaveLength(2);
    expect(new URL(result.urls[1]).searchParams.get('availability')).toBe('out of stock');
  });

  it('the sold-items URL omits maxPrice, deliveryMethod, and region even when set', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('macbook pro', {
      maxPrice: 500,
      fulfillment: 'pickup',
      regionValue: '2',
      includeSoldItems: true,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls[1]).not.toContain('maxPrice');
    expect(result.urls[1]).not.toContain('deliveryMethod');
    expect(result.urls[1]).not.toContain('/marketplace/auckland/');
  });

  it('the first URL is unaffected by includeSoldItems', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('macbook pro', {
      maxPrice: 500,
      fulfillment: 'pickup',
      regionValue: '2',
      includeSoldItems: true,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls[0]).toContain('maxPrice=500');
    expect(result.urls[0]).toContain('/marketplace/auckland/search');
  });

  it('the base URL restricts to used-condition items by default', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('macbook pro', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls).toHaveLength(1);
    expect(new URL(result.urls[0]).searchParams.get('itemCondition')).toBe(
      'used_like_new,used_good,used_fair'
    );
  });

  it('adds a second new-condition URL when includeNewItems is true', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('macbook pro', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: true,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls).toHaveLength(2);
    expect(new URL(result.urls[1]).searchParams.get('itemCondition')).toBe('new');
  });

  it('combines with includeSoldItems: builds used, new, and sold URLs when both true', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('macbook pro', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: true,
      includeNewItems: true,
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls).toHaveLength(3);
    expect(new URL(result.urls[0]).searchParams.get('itemCondition')).toBe(
      'used_like_new,used_good,used_fair'
    );
    expect(new URL(result.urls[1]).searchParams.get('itemCondition')).toBe('new');
    expect(new URL(result.urls[2]).searchParams.get('availability')).toBe('out of stock');
  });
});

describe('buildFacebookDeepSearchDetail', () => {
  it('returns exactly description, extraAttributes, questionsAndAnswers, and pickupLocation when no photos are given', () => {
    const detail = buildFacebookDeepSearchDetail('Nice lamp', { Condition: 'Used' }, 'Auckland');
    expect(detail).toEqual({
      description: 'Nice lamp',
      extraAttributes: { Condition: 'Used' },
      questionsAndAnswers: [],
      pickupLocation: 'Auckland',
    });
  });

  it('never includes buyNowPrice, reserveStatus, pickupAvailable, or shippingAvailable', () => {
    const detail = buildFacebookDeepSearchDetail('desc', {}, null);
    expect(detail).not.toHaveProperty('buyNowPrice');
    expect(detail).not.toHaveProperty('reserveStatus');
    expect(detail).not.toHaveProperty('pickupAvailable');
    expect(detail).not.toHaveProperty('shippingAvailable');
  });

  it('includes photos when given', () => {
    const photos = [
      { thumbnailUrl: 'https://example.com/a.jpg', fullSizeUrl: 'https://example.com/a.jpg' },
    ];
    const detail = buildFacebookDeepSearchDetail('desc', {}, null, photos);
    expect(detail.photos).toEqual(photos);
  });

  it('omits the photos key entirely when none are given, rather than an empty array', () => {
    const detail = buildFacebookDeepSearchDetail('desc', {}, null);
    expect(detail).not.toHaveProperty('photos');
  });
});

// ── extractFacebookDetailsCardData ────────────────────────────────────────────
//
// Same jsdom-swap technique as extractFacebookPhotoUrls below — this function
// also runs in the browser via page.evaluate() and reads the global `document`.

describe('extractFacebookDetailsCardData', () => {
  const realDocument = globalThis.document;

  afterEach(() => {
    globalThis.document = realDocument;
  });

  function useFixture(html: string): Document {
    const dom = new JSDOM(html);
    globalThis.document = dom.window.document as unknown as Document;
    return dom.window.document as unknown as Document;
  }

  it('warns and returns null when no "Details" heading is present on the page', () => {
    useFixture('<body><h1>Some other page</h1></body>');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(extractFacebookDetailsCardData()).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no "Details" heading found'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns when the ancestor climb hits its depth cap without running out of parents', () => {
    // Nest the "Details" heading under more than 12 wrapper <div>s so the
    // depth < 12 climb in extractFacebookDetailsCardData exhausts its cap
    // while ancestor elements still remain above it — the condition the
    // depth-cap warning exists to catch.
    let html = '<h2>Details</h2>';
    for (let i = 0; i < 15; i++) {
      html = `<div>${html}</div>`;
    }
    useFixture(`<body>${html}</body>`);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = extractFacebookDetailsCardData();
      expect(result).not.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('depth cap'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when the card boundary is found comfortably within the depth cap', () => {
    // No `div[justify="all"]` attribute rows here — jsdom doesn't implement
    // `innerText` (a rendering-dependent property with no layout engine
    // behind it), and the row-reading branch below calls `.innerText.trim()`
    // on each row's children, so a fixture with real rows would need a
    // different rendering technique. This fixture only needs to exercise the
    // depth-cap warning, not attribute-row parsing.
    useFixture(`
      <body>
        <div id="card">
          <h2>Details</h2>
        </div>
      </body>
    `);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = extractFacebookDetailsCardData();
      expect(result).not.toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── extractFacebookPhotoUrls ──────────────────────────────────────────────────
//
// This function is written to run in the browser via page.evaluate() and reads
// the global `document`, so it's exercised here against a real jsdom document
// swapped onto `globalThis.document` for the duration of each test — the same
// technique the module already uses `jsdom` for elsewhere (trademeExpired.ts).
// jsdom has no layout engine, so `offsetParent` is always null by default;
// tests that need to simulate a "visible" heading override it explicitly,
// mirroring how a real browser reports an off-screen/display:none element vs.
// a rendered one.

describe('extractFacebookPhotoUrls', () => {
  const realDocument = globalThis.document;

  afterEach(() => {
    globalThis.document = realDocument;
  });

  function useFixture(html: string): Document {
    const dom = new JSDOM(html);
    globalThis.document = dom.window.document as unknown as Document;
    return dom.window.document as unknown as Document;
  }

  function markVisible(el: Element | null): void {
    if (!el) throw new Error('markVisible: element not found in fixture');
    Object.defineProperty(el, 'offsetParent', { value: el.parentElement, configurable: true });
  }

  it('only returns the current listing\'s own photos, excluding a same-page "Today\'s picks" carousel that reuses the same alt-text pattern', () => {
    const fixture = useFixture(`
      <body>
        <h1>Chats</h1>
        <div id="page">
          <div id="listingPane">
            <h1>MacBook Pro 2017</h1>
            <img alt="Product photo of MacBook Pro 2017" src="https://scontent.example.com/mbp-1.jpg" />
            <img alt="Product photo of MacBook Pro 2017" src="https://scontent.example.com/mbp-2.jpg" />
            <img alt="Product photo of MacBook Pro 2017" src="https://scontent.example.com/mbp-3.jpg" />
            <h2>Details</h2>
          </div>
          <div id="picksPane">
            <h2>Today's picks</h2>
            <img alt="Product photo of Vintage lamp" src="https://scontent.example.com/lamp-1.jpg" />
            <img alt="Product photo of Vintage lamp" src="https://scontent.example.com/lamp-2.jpg" />
          </div>
        </div>
      </body>
    `);
    // The "Chats" h1 stays invisible (offsetParent null, jsdom default); only
    // the real listing title is marked visible, so it's the one used to find
    // the scope boundary.
    markVisible(fixture.querySelectorAll('h1')[1]);

    const urls = extractFacebookPhotoUrls(20);

    expect(urls).toEqual([
      'https://scontent.example.com/mbp-1.jpg',
      'https://scontent.example.com/mbp-2.jpg',
      'https://scontent.example.com/mbp-3.jpg',
    ]);
  });

  it('deduplicates repeated photo URLs', () => {
    const fixture = useFixture(`
      <body>
        <h1>MacBook Pro 2017</h1>
        <img alt="Product photo of MacBook Pro 2017" src="https://scontent.example.com/mbp-1.jpg" />
        <img alt="Product photo of MacBook Pro 2017" src="https://scontent.example.com/mbp-1.jpg" />
      </body>
    `);
    markVisible(fixture.querySelector('h1'));

    expect(extractFacebookPhotoUrls(20)).toEqual(['https://scontent.example.com/mbp-1.jpg']);
  });

  it('caps the number of photos returned at maxPhotos', () => {
    const fixture = useFixture(`
      <body>
        <h1>MacBook Pro 2017</h1>
        <img alt="Product photo of MacBook Pro 2017" src="https://scontent.example.com/mbp-1.jpg" />
        <img alt="Product photo of MacBook Pro 2017" src="https://scontent.example.com/mbp-2.jpg" />
        <img alt="Product photo of MacBook Pro 2017" src="https://scontent.example.com/mbp-3.jpg" />
      </body>
    `);
    markVisible(fixture.querySelector('h1'));

    expect(extractFacebookPhotoUrls(2)).toEqual([
      'https://scontent.example.com/mbp-1.jpg',
      'https://scontent.example.com/mbp-2.jpg',
    ]);
  });

  it('has nothing to guard against and returns the page\'s photos unscoped when there is no "Today\'s picks" section', () => {
    const fixture = useFixture(`
      <body>
        <h1>Chats</h1>
        <h1>MacBook Pro 2017</h1>
        <img alt="Product photo of MacBook Pro 2017" src="https://scontent.example.com/mbp-1.jpg" />
      </body>
    `);
    // Deliberately leave both h1s "invisible" — with no "Today's picks" section
    // present there's no unrelated carousel to guard against, so scoping must
    // not depend on finding a visible title heading in this case.
    void fixture;

    expect(extractFacebookPhotoUrls(20)).toEqual(['https://scontent.example.com/mbp-1.jpg']);
  });

  it('falls back to the whole document and warns when a "Today\'s picks" section is present but no visible title heading can be found', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useFixture(`
        <body>
          <h1>Chats</h1>
          <h2>Today's picks</h2>
          <img alt="Product photo of Vintage lamp" src="https://scontent.example.com/lamp-1.jpg" />
        </body>
      `);
      // No h1 is marked visible, simulating a page variant where the title
      // heading can't be structurally identified.

      const urls = extractFacebookPhotoUrls(20);

      expect(urls).toEqual(['https://scontent.example.com/lamp-1.jpg']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[facebook]'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('buildFacebookPhotosFromUrls', () => {
  it('returns undefined for an empty list', () => {
    expect(buildFacebookPhotosFromUrls([])).toBeUndefined();
  });

  it('maps each URL to a photo using the same URL for both thumbnail and full size', () => {
    const urls = ['https://scontent.example.com/a.jpg', 'https://scontent.example.com/b.jpg'];
    expect(buildFacebookPhotosFromUrls(urls)).toEqual([
      { thumbnailUrl: urls[0], fullSizeUrl: urls[0] },
      { thumbnailUrl: urls[1], fullSizeUrl: urls[1] },
    ]);
  });
});

describe('buildFacebookListing', () => {
  it('sets source to facebook', () => {
    const listing = buildFacebookListing(
      'https://facebook.com/marketplace/item/123',
      undefined,
      'Vintage lamp',
      80,
      'Auckland'
    );
    expect(listing.source).toBe('facebook');
  });

  it('sets isAuction to false', () => {
    const listing = buildFacebookListing(
      'https://facebook.com/marketplace/item/123',
      undefined,
      'Lamp',
      null,
      'Wellington'
    );
    expect(listing.isAuction).toBe(false);
  });

  it('defaults relevance to 0 — unscored until the AI filter runs', () => {
    const listing = buildFacebookListing(
      'https://facebook.com/marketplace/item/123',
      undefined,
      'Lamp',
      null,
      'Wellington'
    );
    expect(listing.relevance).toBe(0);
  });

  it('defaults isSold to false when omitted', () => {
    const listing = buildFacebookListing(
      'https://facebook.com/marketplace/item/123',
      undefined,
      'Lamp',
      null,
      'Wellington'
    );
    expect(listing.isSold).toBe(false);
  });

  it('sets isSold to true when passed', () => {
    const listing = buildFacebookListing(
      'https://facebook.com/marketplace/item/123',
      undefined,
      'MacBook Air 2015',
      100,
      'Titahi Bay',
      true
    );
    expect(listing.isSold).toBe(true);
  });
});

// ── isLoginWallUrl ─────────────────────────────────────────────────────────────

describe('isLoginWallUrl', () => {
  it('returns true when the path starts with /login', () => {
    expect(isLoginWallUrl('https://www.facebook.com/login/?next=%2Fmarketplace')).toBe(true);
  });

  it('returns false for a normal marketplace search URL', () => {
    expect(isLoginWallUrl('https://www.facebook.com/marketplace/search?query=lamp')).toBe(false);
  });

  it('returns false for an unparseable URL', () => {
    expect(isLoginWallUrl('not a url')).toBe(false);
  });
});

// ── isLoginWallText ────────────────────────────────────────────────────────────

describe('isLoginWallText', () => {
  it("returns true when the snippet contains 'Log In'", () => {
    expect(isLoginWallText('You must Log In to continue browsing Marketplace')).toBe(true);
  });

  it("returns true when the snippet contains 'sign up'", () => {
    expect(isLoginWallText('Log in or sign up for Facebook')).toBe(true);
  });

  it('returns false for ordinary listing text', () => {
    expect(isLoginWallText('Vintage lamp\nNZ$80\nAuckland')).toBe(false);
  });
});

// ── detectLoginWallAsync ───────────────────────────────────────────────────────

describe('detectLoginWallAsync', () => {
  function stubPage(options: {
    url?: string;
    evaluateResult?: { domMatch: boolean; textSnippet: string };
  }) {
    return {
      url: () => options.url ?? 'https://www.facebook.com/marketplace/search',
      evaluate: async () => options.evaluateResult ?? { domMatch: false, textSnippet: '' },
      // biome-ignore lint/suspicious/noExplicitAny: minimal duck-typed Page stub for unit testing
    } as any;
  }

  it('returns true when the URL path is a login redirect', async () => {
    const page = stubPage({ url: 'https://www.facebook.com/login/?next=%2Fmarketplace' });
    expect(await detectLoginWallAsync(page)).toBe(true);
  });

  it('returns true when the DOM signal matches a login form', async () => {
    const page = stubPage({ evaluateResult: { domMatch: true, textSnippet: '' } });
    expect(await detectLoginWallAsync(page)).toBe(true);
  });

  it('returns true when the text snippet matches login wall copy', async () => {
    const page = stubPage({
      evaluateResult: { domMatch: false, textSnippet: 'Log in to Facebook' },
    });
    expect(await detectLoginWallAsync(page)).toBe(true);
  });

  it('returns false when none of the signals indicate a login wall', async () => {
    const page = stubPage({
      evaluateResult: { domMatch: false, textSnippet: 'Vintage lamp, Auckland' },
    });
    expect(await detectLoginWallAsync(page)).toBe(false);
  });
});

// ── parseFbCookies ─────────────────────────────────────────────────────────────

describe('parseFbCookies', () => {
  it('throws MissingFacebookCookiesError when FB_COOKIES is undefined', () => {
    expect(() => parseFbCookies(undefined)).toThrow(MissingFacebookCookiesError);
  });

  it('throws MissingFacebookCookiesError when FB_COOKIES is empty', () => {
    expect(() => parseFbCookies('')).toThrow(MissingFacebookCookiesError);
  });

  it('throws MissingFacebookCookiesError when FB_COOKIES is not valid JSON', () => {
    expect(() => parseFbCookies('{not json')).toThrow(MissingFacebookCookiesError);
  });

  it('throws MissingFacebookCookiesError when FB_COOKIES parses to an empty array', () => {
    expect(() => parseFbCookies('[]')).toThrow(MissingFacebookCookiesError);
  });

  it('throws MissingFacebookCookiesError when every cookie has expired', () => {
    const expired = JSON.stringify([
      { name: 'c_user', value: '1', expirationDate: 1000 },
      { name: 'xs', value: '2', expires: 2000 },
    ]);
    expect(() => parseFbCookies(expired)).toThrow(MissingFacebookCookiesError);
  });

  it('throws an error whose message tells the caller to set FB_COOKIES', () => {
    expect(() => parseFbCookies(undefined)).toThrow(/FB_COOKIES/);
  });

  it('returns the parsed cookies when FB_COOKIES is valid and unexpired', () => {
    const futureExpiry = Date.now() / 1000 + 3600;
    const cookies = parseFbCookies(
      JSON.stringify([{ name: 'c_user', value: '12345', expirationDate: futureExpiry }])
    );
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: 'c_user', value: '12345' });
  });

  it('returns cookies that have no expiry field at all', () => {
    const cookies = parseFbCookies(JSON.stringify([{ name: 'c_user', value: '12345' }]));
    expect(cookies).toHaveLength(1);
  });

  it('filters out only the expired cookies, keeping the rest', () => {
    const cookies = parseFbCookies(
      JSON.stringify([
        { name: 'expired', value: '1', expirationDate: 1000 },
        { name: 'fresh', value: '2' },
      ])
    );
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: 'fresh' });
  });
});

// ── deriveFacebookDescriptionAndLocation ────────────────────────────────────────
//
// Fixtures below are real `cardInnerText` values captured live from Facebook
// Marketplace listing pages (the "Details" card, DOM-scoped away from the Ads/
// Seller information/Today's picks sections that sit alongside it) — not
// hand-authored — to guard against the punctuation/length heuristics that
// previously mis-scraped ad copy into details and left real descriptions empty.

describe('deriveFacebookDescriptionAndLocation', () => {
  it('extracts a short, unpunctuated description that the old heuristic skipped as a detail line', () => {
    const cardInnerText =
      'Details\nCondition\nUsed – good\n1200 T-Bar Sash cramp\nLower Hutt, Lower Hutt City · Location is approximate';
    expect(
      deriveFacebookDescriptionAndLocation(cardInnerText, 1, { Condition: 'Used – good' })
    ).toEqual({
      description: '1200 T-Bar Sash cramp',
      pickupLocation: 'Lower Hutt, Lower Hutt City',
    });
  });

  it('extracts a multi-line description with no attributes past the count, even with lines that look like keys', () => {
    const cardInnerText = [
      'Details',
      'Condition',
      'Used – like new',
      'Colour',
      'Black',
      'Case type',
      'Deepcool',
      'Newly built custom PC with new 1440p monitor free delivery in the Wellington region',
      'Spec',
      'Intel Core Ultra 7 270K Plus CPU',
      '24 Cores - 36MB Cache',
      'FSP vita GM 850w gold fully modular psu',
      'Lower Hutt, Lower Hutt City · Location is approximate',
    ].join('\n');
    const result = deriveFacebookDescriptionAndLocation(cardInnerText, 3, {
      Condition: 'Used – like new',
      Colour: 'Black',
      'Case type': 'Deepcool',
    });
    expect(result.pickupLocation).toBe('Lower Hutt, Lower Hutt City');
    expect(result.description).toContain('Spec');
    expect(result.description).toContain('Newly built custom PC');
    expect(result.description).not.toContain('Location is approximate');
  });

  it('returns an empty description when the listing has none', () => {
    const cardInnerText =
      'Details\nCondition\nUsed – good\nWellington, Wellington City · Location is approximate';
    expect(
      deriveFacebookDescriptionAndLocation(cardInnerText, 1, { Condition: 'Used – good' })
    ).toEqual({
      description: '',
      pickupLocation: 'Wellington, Wellington City',
    });
  });

  it('strips a trailing "See less" toggle glued onto the last description line', () => {
    const cardInnerText =
      'Details\nCondition\nUsed – fair\nComputer table in poor condition with bits missing but it is usable. See less\nParaparaumu, Kapiti Coast District · Location is approximate';
    expect(
      deriveFacebookDescriptionAndLocation(cardInnerText, 1, { Condition: 'Used – fair' })
    ).toEqual({
      description: 'Computer table in poor condition with bits missing but it is usable.',
      pickupLocation: 'Paraparaumu, Kapiti Coast District',
    });
  });

  it('returns a null pickupLocation when no location line is present', () => {
    const cardInnerText = 'Details\nCondition\nUsed – good\nA short description.';
    expect(
      deriveFacebookDescriptionAndLocation(cardInnerText, 1, { Condition: 'Used – good' })
    ).toEqual({
      description: 'A short description.',
      pickupLocation: null,
    });
  });

  it('does not warn when the attribute row count and line shape agree', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cardInnerText =
        'Details\nCondition\nUsed – good\nA short description.\nWellington, Wellington City · Location is approximate';
      deriveFacebookDescriptionAndLocation(cardInnerText, 1, { Condition: 'Used – good' });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('derives the correct split — instead of scrambling the description — when an attribute value wraps onto an extra line, and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cardInnerText = [
        'Details',
        'Condition',
        'Used – good',
        'Colour',
        'Red, and a really long shade',
        'that wraps across two lines',
        'This is the real description of the item.',
        'Wellington, Wellington City · Location is approximate',
      ].join('\n');
      const attributePairs = {
        Condition: 'Used – good',
        Colour: 'Red, and a really long shade\nthat wraps across two lines',
      };

      const result = deriveFacebookDescriptionAndLocation(cardInnerText, 2, attributePairs);

      expect(result).toEqual({
        description: 'This is the real description of the item.',
        pickupLocation: 'Wellington, Wellington City',
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[facebook]'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('clamps instead of slicing past the end of the text when there are fewer lines than the attribute rows imply, and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 3 attribute rows claimed, but the text only has 2 lines after the
      // heading — simulates a card structure change desyncing the DOM count
      // from the rendered text.
      const cardInnerText = 'Details\nCondition\nUsed – good';

      const result = deriveFacebookDescriptionAndLocation(cardInnerText, 3, {
        Condition: 'Used – good',
        Colour: 'Black',
        Brand: 'Acme',
      });

      expect(result).toEqual({ description: '', pickupLocation: null });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[facebook]'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── fetchFacebookListingDetailAsync ───────────────────────────────────────────

describe('fetchFacebookListingDetailAsync', () => {
  it('throws when the detail page shows a login wall instead of extracting garbage data', async () => {
    const page = makeFacebookPage({ domLoginWall: true });
    await expect(
      fetchFacebookListingDetailAsync(
        page as unknown as Parameters<typeof fetchFacebookListingDetailAsync>[0],
        'https://www.facebook.com/marketplace/item/123/'
      )
    ).rejects.toThrow(/Facebook requires login/);
  });

  it('extracts the description and attributes when no login wall is present, without warning', async () => {
    const detailsCardData: FacebookDetailsCardData = {
      cardInnerText:
        'Details\nCondition\nUsed\nA lovely lamp in great condition.\nWellington, Wellington City · Location is approximate',
      attributeRowCount: 1,
      attributePairs: { Condition: 'Used' },
    };
    const photoUrls = ['https://scontent.example.com/a.jpg', 'https://scontent.example.com/b.jpg'];
    const page = makeFacebookPage({ domLoginWall: false, detailsCardData, photoUrls });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const detail = await fetchFacebookListingDetailAsync(
        page as unknown as Parameters<typeof fetchFacebookListingDetailAsync>[0],
        'https://www.facebook.com/marketplace/item/123/'
      );
      expect(detail.description).toBe('A lovely lamp in great condition.');
      expect(detail.extraAttributes).toEqual({ Condition: 'Used' });
      expect(detail.pickupLocation).toBe('Wellington, Wellington City');
      expect(detail.photos).toEqual([
        { thumbnailUrl: photoUrls[0], fullSizeUrl: photoUrls[0] },
        { thumbnailUrl: photoUrls[1], fullSizeUrl: photoUrls[1] },
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns empty details and warns when the page has no "Details" heading at all', async () => {
    const page = makeFacebookPage({ domLoginWall: false, detailsCardData: null });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const url = 'https://www.facebook.com/marketplace/item/123/';
      const detail = await fetchFacebookListingDetailAsync(
        page as unknown as Parameters<typeof fetchFacebookListingDetailAsync>[0],
        url
      );
      expect(detail.description).toBe('');
      expect(detail.extraAttributes).toEqual({});
      expect(detail.photos).toBeUndefined();
      expect(detail.pickupLocation).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(url));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no Details card found'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── processRawListing (per-URL result cap) ────────────────────────────────────

describe('processRawListing', () => {
  function makeRawListing(overrides: Partial<RawListingMsg> = {}): RawListingMsg {
    return {
      id: '123',
      url: 'https://www.facebook.com/marketplace/item/123/',
      ariaLabel: 'Vintage lamp, NZ$80, Auckland',
      innerText: 'Vintage lamp\nNZ$80\nAuckland',
      thumbnailUrl: '',
      ...overrides,
    };
  }

  it('emits the listing and increments the counter when under the cap', () => {
    const onEvent = vi.fn();
    const counter = { total: 99 };
    processRawListing(makeRawListing(), new Set(), onEvent, counter);

    expect(counter.total).toBe(100);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'listing' }));
  });

  it('does not emit or increment the counter once the cap is reached', () => {
    const onEvent = vi.fn();
    const counter = { total: 100 };
    processRawListing(makeRawListing(), new Set(), onEvent, counter);

    expect(counter.total).toBe(100);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('emits isSold: true for a "Sold" listing (status/separator/price on separate lines)', () => {
    const onEvent = vi.fn();
    processRawListing(
      makeRawListing({
        ariaLabel: 'MacBook Air 2015, NZ$100, Titahi Bay, New Zealand',
        innerText: 'Sold\n·\nNZ$100\nMacBook Air 2015\nTitahi Bay, New Zealand',
      }),
      new Set(),
      onEvent,
      { total: 0 }
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'listing', data: expect.objectContaining({ isSold: true }) })
    );
  });

  it('emits isSold: true for a "Pending" listing', () => {
    const onEvent = vi.fn();
    processRawListing(
      makeRawListing({
        ariaLabel: 'Old chair, NZ$50, Titahi Bay',
        innerText: 'Pending\n·\nNZ$50\nOld chair\nTitahi Bay',
      }),
      new Set(),
      onEvent,
      { total: 0 }
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'listing', data: expect.objectContaining({ isSold: true }) })
    );
  });

  it('emits isSold: false for a normal listing', () => {
    const onEvent = vi.fn();
    processRawListing(makeRawListing(), new Set(), onEvent, { total: 0 });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'listing', data: expect.objectContaining({ isSold: false }) })
    );
  });
});

// ── Empty-results text detection ──────────────────────────────────────────────

describe('isEmptyResultsText', () => {
  it('matches the captured real empty-state sentence', () => {
    expect(
      isEmptyResultsText('No listings found for "fisher price record player" within 60 kilometres')
    ).toBe(true);
  });

  it('matches the secondary "try a new search" sentence', () => {
    expect(
      isEmptyResultsText(
        'Try a new search. Check the spelling, change your filters or try a less specific search term.'
      )
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isEmptyResultsText('NO LISTINGS FOUND FOR "lamp"')).toBe(true);
  });

  it('does not match ordinary Marketplace shell text', () => {
    expect(
      isEmptyResultsText('Marketplace\nSearch results\nFilters\nSort by: Date listed: Newest first')
    ).toBe(false);
  });

  it('does not match an empty string', () => {
    expect(isEmptyResultsText('')).toBe(false);
  });
});

// ── classifyInitialSearchStateAsync ───────────────────────────────────────────
//
// A minimal page stub distinct from `makeFacebookPage` above — it fakes only
// the handful of Page methods this function actually reads (`waitForSelector`,
// `waitForFunction`, `evaluate`, `url`), so these tests exercise the
// classification seam directly instead of paying the full quickSearchAsync
// mock-browser harness for every new signal combination.
describe('classifyInitialSearchStateAsync', () => {
  type ClassifyPageStubOptions = {
    listingsSelectorTimesOut?: boolean;
    listingsAppearOnRetry?: boolean;
    emptyStateAppears?: boolean;
    shellRendered?: boolean;
    bodyText?: string;
  };

  function makeClassifyPageStub(options: ClassifyPageStubOptions = {}) {
    const {
      listingsSelectorTimesOut = false,
      listingsAppearOnRetry = false,
      emptyStateAppears = false,
      shellRendered = false,
      bodyText = '',
    } = options;

    const listingsSelectorAttemptCounts = { count: 0 };

    return {
      url: () => 'https://www.facebook.com/marketplace/search?query=lamp',
      waitForSelector: async (selector: string) => {
        if (selector !== LISTINGS_SELECTOR_IN_TEST) return;
        listingsSelectorAttemptCounts.count++;
        const isRetryAttempt = listingsSelectorAttemptCounts.count > 1;
        if (listingsSelectorTimesOut && !(listingsAppearOnRetry && isRetryAttempt))
          throw new Error('timeout');
      },
      waitForFunction: async () => {
        if (!emptyStateAppears) throw new Error('timeout');
      },
      evaluate: async () => ({ shellRendered, bodyText }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal duck-typed Page stub for unit testing
    } as any;
  }

  it('returns "listings" when the listings selector resolves first', async () => {
    const page = makeClassifyPageStub({ listingsSelectorTimesOut: false });
    expect(await classifyInitialSearchStateAsync(page)).toBe('listings');
  });

  it('returns "empty" when the empty-state marker wins the race and no late listings appear', async () => {
    const page = makeClassifyPageStub({
      listingsSelectorTimesOut: true,
      emptyStateAppears: true,
    });
    expect(await classifyInitialSearchStateAsync(page)).toBe('empty');
  });

  it('returns "listings" when listings appear on the grace re-check after the empty marker wins the race', async () => {
    const page = makeClassifyPageStub({
      listingsSelectorTimesOut: true,
      listingsAppearOnRetry: true,
      emptyStateAppears: true,
    });
    expect(await classifyInitialSearchStateAsync(page)).toBe('listings');
  });

  it('returns "empty" when both waits time out but the settled page shows the shell and the empty-state sentence', async () => {
    const page = makeClassifyPageStub({
      listingsSelectorTimesOut: true,
      emptyStateAppears: false,
      shellRendered: true,
      bodyText: 'No listings found for "lamp" within 60 kilometres',
    });
    expect(await classifyInitialSearchStateAsync(page)).toBe('empty');
  });

  it('returns "blocked" when both waits time out and the shell renders without the empty-state sentence', async () => {
    const page = makeClassifyPageStub({
      listingsSelectorTimesOut: true,
      emptyStateAppears: false,
      shellRendered: true,
      bodyText: 'Marketplace\nSearch results\nFilters',
    });
    expect(await classifyInitialSearchStateAsync(page)).toBe('blocked');
  });

  it('returns "blocked" when both waits time out and the shell never renders', async () => {
    const page = makeClassifyPageStub({
      listingsSelectorTimesOut: true,
      emptyStateAppears: false,
      shellRendered: false,
      bodyText: '',
    });
    expect(await classifyInitialSearchStateAsync(page)).toBe('blocked');
  });
});

// ── quickSearchAsync (login wall paths) ───────────────────────────────────────

describe('facebookRecipe.quickSearchAsync', () => {
  beforeEach(() => {
    resetPageQueue();
    vi.stubEnv('FB_COOKIES', VALID_FB_COOKIES);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits the login-required error immediately and never waits on the listings selector', async () => {
    const page = makeFacebookPage({ domLoginWall: true });
    resetPageQueue(page);

    const events: unknown[] = [];
    await facebookRecipe.quickSearchAsync(
      'https://www.facebook.com/marketplace/search?query=lamp',
      (event) => events.push(event)
    );

    expect(events).toContainEqual({
      type: 'error',
      message: 'Facebook requires login. Set FB_COOKIES environment variable.',
    });
    expect(page.waitForSelectorCalls).toHaveLength(0);
  });

  it('falls back to the generic no-listings message when there is no login wall', async () => {
    const page = makeFacebookPage({
      domLoginWall: false,
      listingsSelectorTimesOut: true,
      textSnippet: '',
    });
    resetPageQueue(page);

    const events: unknown[] = [];
    await facebookRecipe.quickSearchAsync(
      'https://www.facebook.com/marketplace/search?query=lamp',
      (event) => events.push(event)
    );

    expect(events).toContainEqual({
      type: 'error',
      message:
        'No listings found. Facebook may be blocking access or the search returned no results.',
    });
    expect(page.waitForSelectorCalls.length).toBeGreaterThan(0);
  });

  it('completes with zero listings when the empty-state marker renders instead of listings', async () => {
    const page = makeFacebookPage({
      listingsSelectorTimesOut: true,
      emptyStateAppears: true,
      shellRendered: true,
      bodyText: 'No listings found for "fisher price record player" within 60 kilometres',
    });
    resetPageQueue(page);

    const events: Array<{ type: string }> = [];
    await facebookRecipe.quickSearchAsync(
      'https://www.facebook.com/marketplace/search?query=fisher+price+record+player',
      (event) => events.push(event)
    );

    expect(events).toContainEqual({ type: 'complete' });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'listing' }));
    // Returned before the scroll loop — no scrolling on an empty page.
    expect(page.wheelCalls.count).toBe(0);
  });

  it('completes with zero listings when both waits time out but the shell and marker are present', async () => {
    const page = makeFacebookPage({
      listingsSelectorTimesOut: true,
      emptyStateAppears: false,
      shellRendered: true,
      bodyText: 'No listings found for "lamp" within 60 kilometres',
    });
    resetPageQueue(page);

    const events: Array<{ type: string }> = [];
    await facebookRecipe.quickSearchAsync(
      'https://www.facebook.com/marketplace/search?query=lamp',
      (event) => events.push(event)
    );

    expect(events).toContainEqual({ type: 'complete' });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  it('still reports the blocking error when the shell renders without the empty-state marker', async () => {
    const page = makeFacebookPage({
      listingsSelectorTimesOut: true,
      emptyStateAppears: false,
      shellRendered: true,
      bodyText: 'Marketplace\nSearch results\nFilters',
    });
    resetPageQueue(page);

    const events: Array<{ type: string }> = [];
    await facebookRecipe.quickSearchAsync(
      'https://www.facebook.com/marketplace/search?query=lamp',
      (event) => events.push(event)
    );

    expect(events).toContainEqual({
      type: 'error',
      message:
        'No listings found. Facebook may be blocking access or the search returned no results.',
    });
    expect(events).not.toContainEqual({ type: 'complete' });
  });

  it('prefers listings when both the listings selector and the empty marker fire', async () => {
    const page = makeFacebookPage({
      listingsSelectorTimesOut: false,
      emptyStateAppears: true,
    });
    resetPageQueue(page);

    const events: Array<{ type: string }> = [];
    await facebookRecipe.quickSearchAsync(
      'https://www.facebook.com/marketplace/search?query=lamp',
      (event) => events.push(event)
    );

    expect(events).toContainEqual({ type: 'complete' });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
    // Normal listings flow ran: the scroll loop drove the page.
    expect(page.wheelCalls.count).toBeGreaterThan(0);
  });

  it('prefers late-rendering listings over an early empty-state marker (grace re-check)', async () => {
    const page = makeFacebookPage({
      listingsSelectorTimesOut: true,
      listingsAppearOnRetry: true,
      emptyStateAppears: true,
    });
    resetPageQueue(page);

    const events: Array<{ type: string }> = [];
    await facebookRecipe.quickSearchAsync(
      'https://www.facebook.com/marketplace/search?query=lamp',
      (event) => events.push(event)
    );

    expect(events).toContainEqual({ type: 'complete' });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(page.wheelCalls.count).toBeGreaterThan(0);
  });
});

// ── quickSearchAsync (domain concurrency limiting) ────────────────────────────
//
// Every quick search launches its own authenticated headless browser off the
// shared FB_COOKIES session, and a sold-items discover produces two Facebook
// URLs fired concurrently by the frontend — so the browser launch must be
// routed through the per-domain limiter, exactly like deepSearchAsync's
// per-listing fetches already are.

describe('facebookRecipe.quickSearchAsync — domain concurrency limiting', () => {
  beforeEach(() => {
    resetPageQueue();
    browserSessionTracker.reset();
    enqueuedUrls.length = 0;
    vi.stubEnv('FB_COOKIES', VALID_FB_COOKIES);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes the browser launch through the domain limiter, keyed by the search URL', async () => {
    const searchUrl = 'https://www.facebook.com/marketplace/search?query=lamp';
    resetPageQueue(makeFacebookPage({ domLoginWall: true }));

    await facebookRecipe.quickSearchAsync(searchUrl, () => {});

    expect(enqueuedUrls).toContain(searchUrl);
  });

  it('never overlaps browser sessions when the limiter serializes two concurrent searches', async () => {
    resetPageQueue(
      makeFacebookPage({ domLoginWall: true }),
      makeFacebookPage({ domLoginWall: true })
    );

    await Promise.all([
      facebookRecipe.quickSearchAsync(
        'https://www.facebook.com/marketplace/search?query=lamp',
        () => {}
      ),
      facebookRecipe.quickSearchAsync(
        'https://www.facebook.com/marketplace/search?query=lamp&availability=out%20of%20stock',
        () => {}
      ),
    ]);

    expect(browserSessionTracker.maxActiveCount).toBe(1);
  });
});

// ── deepSearchAsync (per-listing error isolation) ─────────────────────────────

describe('facebookRecipe.deepSearchAsync', () => {
  beforeEach(() => {
    resetPageQueue();
    vi.stubEnv('FB_COOKIES', VALID_FB_COOKIES);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports a detail-error for a login-walled listing without aborting the rest of the batch', async () => {
    const okBodyText = 'Item\nDetails\nCondition\nUsed\nA great chair.\nSee more\n';
    const okPage = makeFacebookPage({ domLoginWall: false, bodyText: okBodyText });
    const loginWalledPage = makeFacebookPage({ domLoginWall: true });
    resetPageQueue(okPage, loginWalledPage);

    const listingOk = buildFacebookListing(
      'https://www.facebook.com/marketplace/item/1/',
      undefined,
      'Chair',
      50,
      'Auckland'
    );
    const listingBlocked = buildFacebookListing(
      'https://www.facebook.com/marketplace/item/2/',
      undefined,
      'Table',
      100,
      'Wellington'
    );

    const events: Array<{ type: string; url?: string; message?: string }> = [];
    await facebookRecipe.deepSearchAsync([listingOk, listingBlocked], (event) =>
      events.push(event)
    );

    const detailEvent = events.find((e) => e.type === 'detail' && e.url === listingOk.url);
    const detailErrorEvent = events.find(
      (e) => e.type === 'detail-error' && e.url === listingBlocked.url
    );
    expect(detailEvent).toBeDefined();
    expect(detailErrorEvent).toBeDefined();
    expect(detailErrorEvent?.message).toMatch(/Facebook requires login/);
    expect(events).toContainEqual({ type: 'complete' });
  });

  it('waits on real DOM signals instead of a fixed sleep before reading the page', async () => {
    const okBodyText = 'Item\nDetails\nCondition\nUsed\nA great chair.\nSee more\n';
    const okPage = makeFacebookPage({ domLoginWall: false, bodyText: okBodyText });
    resetPageQueue(okPage);

    const listingOk = buildFacebookListing(
      'https://www.facebook.com/marketplace/item/1/',
      undefined,
      'Chair',
      50,
      'Auckland'
    );

    await facebookRecipe.deepSearchAsync([listingOk], () => {});

    expect(okPage.waitForSelectorCalls).toContain('h2:has-text("Details")');
    expect(okPage.waitForTimeoutCalls).toEqual([]);
  });
});
