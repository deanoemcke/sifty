import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCooldownStore } from '../../lib/recipes/base';
import { aiJSON } from '../ai';
import {
  buildFacebookDeepSearchDetail,
  buildFacebookListing,
  buildFacebookSearchQueryAsync,
  buildFacebookUrl,
  detectLoginWallAsync,
  extractImplicitFilters,
  facebookRecipe,
  fetchFacebookListingDetailAsync,
  isLoginWallText,
  isLoginWallUrl,
  MissingFacebookCookiesError,
  parseFacebookPriceLines,
  parseFbCookies,
} from './facebook';

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
type FacebookPageOptions = {
  url?: string;
  domLoginWall?: boolean;
  textSnippet?: string;
  listingsSelectorTimesOut?: boolean;
  cookieBannerVisible?: boolean;
  bodyText?: string;
};

const { getNextPage, resetPageQueue, makeFacebookPage } = vi.hoisted(() => {
  const queue: unknown[] = [];

  function makeFacebookPage(options: FacebookPageOptions = {}) {
    const {
      url = 'https://www.facebook.com/marketplace/search?query=lamp',
      domLoginWall = false,
      textSnippet = '',
      listingsSelectorTimesOut = false,
      cookieBannerVisible = false,
      bodyText = '',
    } = options;

    const waitForSelectorCalls: string[] = [];

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
      waitForTimeout: async () => {},
      waitForSelector: async (selector: string) => {
        waitForSelectorCalls.push(selector);
        if (listingsSelectorTimesOut) throw new Error('timeout');
      },
      evaluate: async (fn: (...args: unknown[]) => unknown) => {
        if (fn.toString().includes('login_popup_cta_form')) {
          return { domMatch: domLoginWall, textSnippet };
        }
        return bodyText;
      },
      mouse: { wheel: async () => {} },
      keyboard: { press: async () => {} },
      close: async () => {},
      waitForSelectorCalls,
    };
  }

  return {
    getNextPage: (): ReturnType<typeof makeFacebookPage> =>
      (queue.shift() as ReturnType<typeof makeFacebookPage>) ?? makeFacebookPage(),
    resetPageQueue: (...items: unknown[]) => queue.splice(0, queue.length, ...items),
    makeFacebookPage,
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => getNextPage(),
        addCookies: async () => {},
      }),
      close: async () => {},
    }),
  },
}));

vi.mock('../../lib/queue', () => ({
  enqueue: (_: string, fn: () => Promise<unknown>) => fn(),
}));

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
});

// ── buildFacebookUrl ──────────────────────────────────────────────────────────

describe('buildFacebookUrl', () => {
  it('always sets query, exact, and sortBy', () => {
    const url = buildFacebookUrl('macbook', 0, 'any', undefined, TEST_REGIONS);
    expect(url).toContain('query=macbook');
    expect(url).toContain('exact=false');
    expect(url).toContain('sortBy=creation_time_descend');
  });

  it('adds maxPrice when > 0', () => {
    const url = buildFacebookUrl('macbook', 800, 'any', undefined, TEST_REGIONS);
    expect(url).toContain('maxPrice=800');
  });

  it('omits maxPrice when 0', () => {
    const url = buildFacebookUrl('macbook', 0, 'any', undefined, TEST_REGIONS);
    expect(url).not.toContain('maxPrice');
  });

  it('sets deliveryMethod=local_pick_up for pickup fulfillment', () => {
    const url = buildFacebookUrl('macbook', 0, 'pickup', undefined, TEST_REGIONS);
    expect(url).toContain('deliveryMethod=local_pick_up');
  });

  it('sets deliveryMethod=shipping for shipping fulfillment', () => {
    const url = buildFacebookUrl('macbook', 0, 'shipping', undefined, TEST_REGIONS);
    expect(url).toContain('deliveryMethod=shipping');
  });

  it('omits deliveryMethod for "any" fulfillment', () => {
    const url = buildFacebookUrl('macbook', 0, 'any', undefined, TEST_REGIONS);
    expect(url).not.toContain('deliveryMethod');
  });

  it('injects location segment when pickup and regionValue matches a region', () => {
    const url = buildFacebookUrl('macbook', 0, 'pickup', '2', TEST_REGIONS);
    expect(url).toContain('/marketplace/auckland/search');
  });

  it('omits location segment when pickup but regionValue is undefined', () => {
    const url = buildFacebookUrl('macbook', 0, 'pickup', undefined, TEST_REGIONS);
    expect(url).toContain('/marketplace/search');
    expect(url).not.toContain('/marketplace/auckland/');
  });

  it('omits location segment when fulfillment is "any" even with regionValue', () => {
    const url = buildFacebookUrl('macbook', 0, 'any', '2', TEST_REGIONS);
    expect(url).not.toContain('/marketplace/auckland/');
  });

  it('omits location segment when regionValue does not match any region', () => {
    const url = buildFacebookUrl('macbook', 0, 'pickup', '999', TEST_REGIONS);
    expect(url).toContain('/marketplace/search');
    expect(url).not.toContain('/marketplace/undefined/');
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
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.urls[0]).toContain('maxPrice=500');
  });

  it('injects region location segment when pickup fulfillment and matching region', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'laptop' }));
    const result = await facebookRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'pickup',
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
      getAiConfig: () => MOCK_AI_CONFIG,
    });
    expect(result.warnings).toEqual([]);
  });

  it('passes the trimmed prompt to the AI', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ query: 'macbook pro' }));
    await facebookRecipe.buildDiscoverUrlsAsync('  macbook pro  ', {
      maxPrice: 0,
      fulfillment: 'any',
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
        getAiConfig: () => MOCK_AI_CONFIG,
      })
    ).rejects.toThrow('AI unavailable');
  });
});

describe('buildFacebookDeepSearchDetail', () => {
  it('returns exactly description, extraAttributes, questionsAndAnswers, and pickupLocation', () => {
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

  it('extracts the description when no login wall is present', async () => {
    const bodyText =
      'Item title\nDetails\nCondition\nUsed\nA lovely lamp in great condition.\nSee more\n';
    const page = makeFacebookPage({ domLoginWall: false, bodyText });
    const detail = await fetchFacebookListingDetailAsync(
      page as unknown as Parameters<typeof fetchFacebookListingDetailAsync>[0],
      'https://www.facebook.com/marketplace/item/123/'
    );
    expect(detail.description).toBe('A lovely lamp in great condition.');
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
});
