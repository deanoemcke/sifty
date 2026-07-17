import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing, ProviderCooldownStore } from '../../lib/recipes/base';
import { aiJSON } from '../ai';
import { ROOT_SEARCH_RESULT_THRESHOLD } from '../constants';
import {
  type CategoryLegacyPathRow,
  type CategoryWithEmbeddingRow,
  getDb,
  stmtGetAllCategoriesWithEmbeddings,
  stmtGetCategoryLegacyPath,
} from '../db';
import { embedTextAsync } from '../embeddings';
import {
  buildListing,
  buildPhotosFromUrls,
  buildRootMarketplaceSearchUrl,
  buildTrademeUrl,
  extractImplicitFilters,
  fetchSearchPage1Async,
  fetchSingleListingDetailAsync,
  mapReserveState,
  parseListingDetailResponse,
  parseSearchApiResponse,
  parseTradeMeDate,
  trademeRecipe,
} from './trademe';
import type { DiscoverEntry } from './trademeCategoryResolver';

// `applyAiJsonResult` is left as the real implementation (not mocked) so these tests
// exercise the actual orchestration logic — unwrapping an ok result, or marking the
// cooldown store and throwing for a rate-limited one — with only `aiJSON` faked.
vi.mock('../ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai')>();
  return { ...actual, aiJSON: vi.fn() };
});
vi.mock('../db', () => ({
  getDb: vi.fn(),
  stmtGetAllCategoriesWithEmbeddings: vi.fn(),
  stmtGetCategoryLegacyPath: vi.fn(),
}));
// Only `embedTextAsync` is faked — `cosineSimilarity` stays real so the shortlist
// ranking exercised by these tests is the actual implementation.
vi.mock('../embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../embeddings')>();
  return { ...actual, embedTextAsync: vi.fn() };
});

// ── Playwright mock for quickSearch integration tests ─────────────────────────

const { getNextPage, resetPageQueue, makeDetailPage, browserSessionTracker, PROBE_FETCH_FAILURE } =
  vi.hoisted(() => {
    const queue: unknown[] = [];
    // Sentinel pushed into the page queue (via resetPageQueue) to simulate a network/timeout
    // failure on the next page.goto() call, rather than a successful-but-empty response.
    const PROBE_FETCH_FAILURE = Symbol('probe-fetch-failure');

    // Tracks how many mocked Chromium instances are live at once, so tests can
    // assert that concurrent quick searches do (or don't) stack browser sessions.
    const browserSessionTracker = {
      activeCount: 0,
      maxActiveCount: 0,
      reset() {
        this.activeCount = 0;
        this.maxActiveCount = 0;
      },
    };

    function makePage(data: unknown) {
      const handlers: Array<(r: unknown) => void> = [];
      return {
        on: (_: string, h: (r: unknown) => void) => {
          handlers.push(h);
        },
        off: () => {},
        goto: async () => {
          const response = {
            url: () => 'https://api.trademe.co.nz/v1/search/general.json',
            status: () => 200,
            json: async () => data,
          };
          for (const h of [...handlers]) h(response);
        },
        close: async () => {},
      };
    }

    // Configurable detail-endpoint mock for fetchSingleListingDetailAsync tests —
    // unlike makePage (fixed to the search endpoint), url/status/respond are tunable
    // per test so the same factory covers the happy path, non-200, and no-response cases.
    function makeDetailPage(
      options: {
        data?: unknown;
        url?: string;
        status?: number;
        respond?: boolean;
        jsonError?: boolean;
      } = {}
    ) {
      const handlers: Array<(r: unknown) => void> = [];
      return {
        on: (_: string, h: (r: unknown) => void) => {
          handlers.push(h);
        },
        off: () => {},
        goto: async () => {
          if (options.respond === false) return;
          const response = {
            url: () => options.url ?? 'https://api.trademe.co.nz/v1/listings/12345.json',
            status: () => options.status ?? 200,
            json: async () => {
              if (options.jsonError) throw new SyntaxError('Unexpected end of JSON input');
              return options.data ?? {};
            },
          };
          for (const h of [...handlers]) h(response);
        },
      };
    }

    function makeFailingPage() {
      return {
        on: () => {},
        off: () => {},
        goto: async () => {
          throw new Error('net::ERR_CONNECTION_TIMED_OUT');
        },
        close: async () => {},
      };
    }

    return {
      getNextPage: () => {
        const next = queue.shift();
        return next === PROBE_FETCH_FAILURE ? makeFailingPage() : makePage(next ?? {});
      },
      resetPageQueue: (...items: unknown[]) => {
        queue.splice(0, queue.length, ...items);
      },
      makeDetailPage,
      browserSessionTracker,
      PROBE_FETCH_FAILURE,
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
        newContext: async () => ({ newPage: async () => getNextPage() }),
        close: async () => {
          browserSessionTracker.activeCount--;
        },
      };
    },
  },
}));

// The real `enqueue` (per-domain `ConcurrencyQueue`, trademe.co.nz capped at 3 —
// see `src/lib/queue.ts`) is used as-is, wrapped only to record which URLs are
// routed through it. A plain passthrough mock would make a bypassed limiter
// indistinguishable from a working one, and pagination already nests enqueue
// calls inside the outer quick-search task, so a hand-rolled full-serialization
// mock (concurrency 1) would deadlock — the real bounded queue handles that
// nesting correctly because it isn't a hand-rolled chain of ordering.
const { enqueuedUrls } = vi.hoisted(() => ({ enqueuedUrls: [] as string[] }));

vi.mock('../../lib/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queue')>();
  function trackingEnqueue<T>(url: string, asyncTask: () => Promise<T>): Promise<T> {
    enqueuedUrls.push(url);
    return actual.enqueue(url, asyncTask);
  }
  return { ...actual, enqueue: trackingEnqueue };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _makeListing(overrides: Partial<Listing> = {}): Listing {
  const { source = 'trademe', ...restOverrides } = overrides;
  return {
    source,
    title: 'MacBook Pro 14" 2021 M1 Pro 16GB',
    price: 1500,
    location: 'Auckland City, Auckland',
    url: 'https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/listing/12345',
    isAuction: true,
    relevance: 0,
    ...restOverrides,
  };
}

// Keep the listing helper available for future use
_makeListing;

// ── computeAlertFingerprint ───────────────────────────────────────────────────

describe('trademeRecipe.computeAlertFingerprint', () => {
  it('is the same when only the price differs — auction bids changing must not re-trigger a "new listing" alert', () => {
    const a = _makeListing({ price: 50 });
    const b = _makeListing({ price: 75 });
    expect(trademeRecipe.computeAlertFingerprint(a)).toBe(trademeRecipe.computeAlertFingerprint(b));
  });

  it('differs when thumbnailUrl differs', () => {
    const a = _makeListing({ thumbnailUrl: 'https://trademe.tmcdn.co.nz/photoserver/full/1.jpg' });
    const b = _makeListing({ thumbnailUrl: 'https://trademe.tmcdn.co.nz/photoserver/full/2.jpg' });
    expect(trademeRecipe.computeAlertFingerprint(a)).not.toBe(
      trademeRecipe.computeAlertFingerprint(b)
    );
  });

  it('is the same for a listing relisted under a different URL id', () => {
    const original = _makeListing({ url: 'https://example.com/marketplace/listing/111' });
    const relisted = _makeListing({ url: 'https://example.com/marketplace/listing/999' });
    expect(trademeRecipe.computeAlertFingerprint(original)).toBe(
      trademeRecipe.computeAlertFingerprint(relisted)
    );
  });
});

// ── buildListing ──────────────────────────────────────────────────────────────

describe('buildListing', () => {
  const baseRaw = {
    title: 'MacBook Pro 14"',
    priceDisplay: '$1,500',
    suburb: 'Auckland City',
    region: 'Auckland',
    canonicalPath: '/marketplace/computers/laptops/laptops/apple/listing/99999',
    pictureHref: 'https://trademe.tmcdn.co.nz/photoserver/thumb/123.jpg',
    isBuyNowOnly: false,
    hasBuyNow: false,
  };

  it('builds a Listing from a valid RawApiItem', () => {
    const listing = buildListing(baseRaw);
    expect(listing).not.toBeNull();
    expect(listing?.title).toBe('MacBook Pro 14"');
    expect(listing?.price).toBe(1500);
    expect(listing?.location).toBe('Auckland City, Auckland');
    expect(listing?.url).toBe(
      'https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/listing/99999'
    );
    expect(listing?.thumbnailUrl).toBe('https://trademe.tmcdn.co.nz/photoserver/full/123.jpg');
    expect(listing?.isAuction).toBe(true);
  });

  it('returns null when title is empty', () => {
    expect(buildListing({ ...baseRaw, title: '' })).toBeNull();
  });

  it('returns null when canonicalPath is empty', () => {
    expect(buildListing({ ...baseRaw, canonicalPath: '' })).toBeNull();
  });

  it('returns null price when priceDisplay is empty', () => {
    const listing = buildListing({ ...baseRaw, priceDisplay: '' });
    expect(listing?.price).toBeNull();
  });

  it('falls back to "Unknown" location when suburb and region are absent', () => {
    const listing = buildListing({ ...baseRaw, suburb: undefined, region: undefined });
    expect(listing?.location).toBe('Unknown');
  });

  it('uses region alone when suburb is absent', () => {
    const listing = buildListing({ ...baseRaw, suburb: undefined });
    expect(listing?.location).toBe('Auckland');
  });

  it('omits thumbnailUrl when pictureHref is absent', () => {
    const listing = buildListing({ ...baseRaw, pictureHref: undefined });
    expect(listing?.thumbnailUrl).toBeUndefined();
  });

  it('sets source to trademe', () => {
    const listing = buildListing(baseRaw);
    expect(listing?.source).toBe('trademe');
  });

  it('defaults relevance to 0 — unscored until the AI filter runs', () => {
    const listing = buildListing(baseRaw);
    expect(listing?.relevance).toBe(0);
  });

  it('sets isAuction false when isBuyNowOnly is true', () => {
    const listing = buildListing({ ...baseRaw, isBuyNowOnly: true, hasBuyNow: true });
    expect(listing?.isAuction).toBe(false);
  });

  it('sets isAuction true when isBuyNowOnly is false', () => {
    const listing = buildListing({ ...baseRaw, isBuyNowOnly: false, hasBuyNow: false });
    expect(listing?.isAuction).toBe(true);
  });

  it('sets buyNowPrice when hasBuyNow is true', () => {
    const listing = buildListing({ ...baseRaw, hasBuyNow: true, buyNowPrice: 2000 });
    expect(listing?.buyNowPrice).toBe(2000);
  });

  it('omits buyNowPrice when hasBuyNow is false', () => {
    const listing = buildListing({ ...baseRaw, hasBuyNow: false });
    expect(listing).not.toHaveProperty('buyNowPrice');
  });

  it('maps reserveState via mapReserveState', () => {
    const listing = buildListing({ ...baseRaw, reserveState: 1 });
    expect(listing?.reserveStatus).toBe('MET');
  });

  it('always sets reserveStatus even when reserveState is absent', () => {
    const listing = buildListing(baseRaw);
    expect(listing?.reserveStatus).toBe('NONE');
  });

  it('sets startDate/endDate when present on raw', () => {
    const listing = buildListing({
      ...baseRaw,
      startDate: '/Date(1782954111747)/',
      endDate: '/Date(1783954111747)/',
    });
    expect(listing?.startDate).toBe(new Date(1782954111747).toISOString());
    expect(listing?.endDate).toBe(new Date(1783954111747).toISOString());
  });

  it('omits startDate/endDate when absent on raw', () => {
    const listing = buildListing(baseRaw);
    expect(listing).not.toHaveProperty('startDate');
    expect(listing).not.toHaveProperty('endDate');
  });

  it('sets categoryPath when present', () => {
    const listing = buildListing({ ...baseRaw, categoryPath: 'Computers/Laptops' });
    expect(listing?.categoryPath).toBe('Computers/Laptops');
  });

  it('omits categoryPath when absent', () => {
    const listing = buildListing(baseRaw);
    expect(listing).not.toHaveProperty('categoryPath');
  });

  it('sets photos via buildPhotosFromUrls when photoUrls present', () => {
    const listing = buildListing({
      ...baseRaw,
      photoUrls: ['https://trademe.tmcdn.co.nz/photoserver/thumb/1.jpg'],
    });
    expect(listing?.photos).toEqual([
      {
        thumbnailUrl: 'https://trademe.tmcdn.co.nz/photoserver/thumb/1.jpg',
        fullSizeUrl: 'https://trademe.tmcdn.co.nz/photoserver/full/1.jpg',
      },
    ]);
  });

  it('omits photos when photoUrls absent', () => {
    const listing = buildListing(baseRaw);
    expect(listing).not.toHaveProperty('photos');
  });

  it('sets shippingCost when present', () => {
    const listing = buildListing({ ...baseRaw, shippingCost: 15 });
    expect(listing?.shippingCost).toBe(15);
  });

  it('omits shippingCost when absent', () => {
    const listing = buildListing(baseRaw);
    expect(listing).not.toHaveProperty('shippingCost');
  });

  it('sets seller when memberId present', () => {
    const listing = buildListing({ ...baseRaw, memberId: 42, isSuperSeller: true });
    expect(listing?.seller).toEqual({ memberId: 42, isTopSeller: true });
  });

  it('defaults isTopSeller to false when isSuperSeller absent', () => {
    const listing = buildListing({ ...baseRaw, memberId: 42 });
    expect(listing?.seller).toEqual({ memberId: 42, isTopSeller: false });
  });

  it('omits seller when memberId absent', () => {
    const listing = buildListing(baseRaw);
    expect(listing).not.toHaveProperty('seller');
  });
});

// ── parseSearchApiResponse ────────────────────────────────────────────────────

describe('parseSearchApiResponse', () => {
  const baseItem = {
    Title: 'MacBook Pro 14"',
    PriceDisplay: '$1,500',
    Region: 'Auckland',
    Suburb: 'Auckland City',
    CanonicalPath: '/marketplace/computers/laptops/laptops/apple/listing/99999',
    PictureHref: 'https://trademe.tmcdn.co.nz/photoserver/thumb/123.jpg',
  };

  it('maps fields correctly', () => {
    const { listings } = parseSearchApiResponse({ List: [baseItem], TotalCount: 1, PageSize: 56 });
    expect(listings).toHaveLength(1);
    expect(listings[0].title).toBe('MacBook Pro 14"');
    expect(listings[0].price).toBe(1500);
    expect(listings[0].location).toBe('Auckland City, Auckland');
    expect(listings[0].url).toBe(
      'https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/listing/99999'
    );
    expect(listings[0].thumbnailUrl).toBe('https://trademe.tmcdn.co.nz/photoserver/full/123.jpg');
  });

  it('reads TotalCount and PageSize', () => {
    const result = parseSearchApiResponse({ List: [baseItem], TotalCount: 93, PageSize: 22 });
    expect(result.totalCount).toBe(93);
    expect(result.pageSize).toBe(22);
  });

  it('falls back to list length when PageSize is missing', () => {
    const items = [baseItem, { ...baseItem, Title: 'MacBook Air' }];
    const result = parseSearchApiResponse({ List: items, TotalCount: 2 });
    expect(result.pageSize).toBe(2);
  });

  it('filters out items missing title or URL', () => {
    const { listings } = parseSearchApiResponse({
      List: [baseItem, { ...baseItem, Title: '' }, { ...baseItem, CanonicalPath: '' }],
      TotalCount: 3,
      PageSize: 56,
    });
    expect(listings).toHaveLength(1);
  });

  it('handles empty list', () => {
    const result = parseSearchApiResponse({ List: [], TotalCount: 0, PageSize: 56 });
    expect(result.listings).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it('handles missing List gracefully', () => {
    const result = parseSearchApiResponse({ TotalCount: 0 });
    expect(result.listings).toHaveLength(0);
  });

  it('joins Suburb and Region with comma', () => {
    const { listings } = parseSearchApiResponse({ List: [baseItem], TotalCount: 1, PageSize: 56 });
    expect(listings[0].location).toBe('Auckland City, Auckland');
  });

  it('falls back to Region alone when Suburb is missing', () => {
    const item = { ...baseItem, Suburb: undefined };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].location).toBe('Auckland');
  });

  it('maps IsBuyNowOnly to isAuction=false', () => {
    const item = { ...baseItem, IsBuyNowOnly: true, HasBuyNow: true };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].isAuction).toBe(false);
  });

  it('maps HasBuyNow + BuyNowPrice', () => {
    const item = { ...baseItem, HasBuyNow: true, BuyNowPrice: 2000 };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].buyNowPrice).toBe(2000);
  });

  it('maps ReserveState via mapReserveState', () => {
    const item = { ...baseItem, ReserveState: 2 };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].reserveStatus).toBe('NOT_MET');
  });

  it('maps StartDate/EndDate through parseTradeMeDate', () => {
    const item = {
      ...baseItem,
      StartDate: '/Date(1782954111747)/',
      EndDate: '/Date(1783954111747)/',
    };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].startDate).toBe(new Date(1782954111747).toISOString());
    expect(listings[0].endDate).toBe(new Date(1783954111747).toISOString());
  });

  it('maps CategoryPath', () => {
    const item = { ...baseItem, CategoryPath: 'Computers/Laptops' };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].categoryPath).toBe('Computers/Laptops');
  });

  it('maps PhotoUrls via buildPhotosFromUrls', () => {
    const item = {
      ...baseItem,
      PhotoUrls: ['https://trademe.tmcdn.co.nz/photoserver/thumb/1.jpg'],
    };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].photos).toEqual([
      {
        thumbnailUrl: 'https://trademe.tmcdn.co.nz/photoserver/thumb/1.jpg',
        fullSizeUrl: 'https://trademe.tmcdn.co.nz/photoserver/full/1.jpg',
      },
    ]);
  });

  it('maps MemberId/IsSuperSeller to seller', () => {
    const item = { ...baseItem, MemberId: 42, IsSuperSeller: true };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].seller).toEqual({ memberId: 42, isTopSeller: true });
  });

  it('maps ShippingDetails.SuggestedShipping.Price to shippingCost', () => {
    const item = {
      ...baseItem,
      ShippingDetails: { SuggestedShipping: { Price: 12.5 } },
    };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].shippingCost).toBe(12.5);
  });

  it('omits shippingCost when ShippingDetails is absent', () => {
    const { listings } = parseSearchApiResponse({ List: [baseItem], TotalCount: 1, PageSize: 56 });
    expect(listings[0]).not.toHaveProperty('shippingCost');
  });
});

// ── mapReserveState ───────────────────────────────────────────────────────────

describe('mapReserveState', () => {
  it('maps undefined to NONE', () => {
    expect(mapReserveState(undefined)).toBe('NONE');
  });
  it('maps 1 to MET', () => {
    expect(mapReserveState(1)).toBe('MET');
  });
  it('maps 2 to NOT_MET', () => {
    expect(mapReserveState(2)).toBe('NOT_MET');
  });
  it('maps 3 (buy-now-only) to UNKNOWN', () => {
    expect(mapReserveState(3)).toBe('UNKNOWN');
  });
  it('maps an unrecognized number to UNKNOWN', () => {
    expect(mapReserveState(99)).toBe('UNKNOWN');
  });
});

// ── parseTradeMeDate ──────────────────────────────────────────────────────────

describe('parseTradeMeDate', () => {
  it('parses a valid wire string to a matching ISO string', () => {
    expect(parseTradeMeDate('/Date(1782954111747)/')).toBe(new Date(1782954111747).toISOString());
  });
  it('returns undefined for a malformed string', () => {
    expect(parseTradeMeDate('not a date')).toBeUndefined();
  });
  it('returns undefined for undefined input', () => {
    expect(parseTradeMeDate(undefined)).toBeUndefined();
  });
  it('returns undefined for an empty string', () => {
    expect(parseTradeMeDate('')).toBeUndefined();
  });
});

// ── buildPhotosFromUrls ───────────────────────────────────────────────────────

describe('buildPhotosFromUrls', () => {
  it('returns undefined for undefined input', () => {
    expect(buildPhotosFromUrls(undefined)).toBeUndefined();
  });
  it('returns undefined for an empty array', () => {
    expect(buildPhotosFromUrls([])).toBeUndefined();
  });
  it('maps a single URL to thumbnail/full-size pair', () => {
    const photos = buildPhotosFromUrls(['https://trademe.tmcdn.co.nz/photoserver/thumb/1.jpg']);
    expect(photos).toEqual([
      {
        thumbnailUrl: 'https://trademe.tmcdn.co.nz/photoserver/thumb/1.jpg',
        fullSizeUrl: 'https://trademe.tmcdn.co.nz/photoserver/full/1.jpg',
      },
    ]);
  });
  it('maps multiple URLs, preserving order', () => {
    const photos = buildPhotosFromUrls([
      'https://trademe.tmcdn.co.nz/photoserver/thumb/1.jpg',
      'https://trademe.tmcdn.co.nz/photoserver/thumb/2.jpg',
    ]);
    expect(photos?.map((p) => p.thumbnailUrl)).toEqual([
      'https://trademe.tmcdn.co.nz/photoserver/thumb/1.jpg',
      'https://trademe.tmcdn.co.nz/photoserver/thumb/2.jpg',
    ]);
    expect(photos?.map((p) => p.fullSizeUrl)).toEqual([
      'https://trademe.tmcdn.co.nz/photoserver/full/1.jpg',
      'https://trademe.tmcdn.co.nz/photoserver/full/2.jpg',
    ]);
  });
});

// ── parseListingDetailResponse ────────────────────────────────────────────────

describe('parseListingDetailResponse', () => {
  const startDateWire = '/Date(1782954111747)/';
  const endDateWire = '/Date(1783954111747)/';
  const askedAtWire = '/Date(1784000000000)/';
  const answeredAtWire = '/Date(1784010000000)/';
  const dateJoinedWire = '/Date(1600000000000)/';

  const fullListing = {
    Body: 'This laptop is working but has a bit of wear and tear.',
    Attributes: [
      { Name: 'Condition', Value: 'Used', DisplayValue: 'Used (good)' },
      { Name: 'Screen Size', Value: '15"' },
    ],
    Questions: {
      List: [
        {
          Comment: 'Is this available?',
          Answer: 'Yes it is',
          AskingMember: { Nickname: 'buyer1' },
          CommentDate: askedAtWire,
          AnswerDate: answeredAtWire,
        },
      ],
    },
    HasBuyNow: true,
    BuyNowPrice: 1500,
    ReserveState: 1,
    ShippingOptions: [{ Price: 10 }, { Price: 5 }],
    StartDate: startDateWire,
    EndDate: endDateWire,
    CategoryPath: 'Computers/Laptops',
    Photos: [
      {
        Value: {
          Thumbnail: 'https://example.com/thumb1.jpg',
          FullSize: 'https://example.com/full1.jpg',
        },
      },
    ],
    Member: {
      MemberId: 42,
      Nickname: 'seaf73',
      FeedbackCount: 27,
      IsTopSeller: true,
      DateJoined: dateJoinedWire,
    },
    AllowsPickups: 1,
    Suburb: 'Invercargill',
    Region: 'Southland',
  };

  it('maps every field correctly for a fully-populated real listing', () => {
    const detail = parseListingDetailResponse(fullListing);
    expect(detail.description).toBe('This laptop is working but has a bit of wear and tear.');
    expect(detail.extraAttributes).toEqual({ Condition: 'Used (good)', 'Screen Size': '15"' });
    expect(detail.questionsAndAnswers).toEqual([
      {
        question: 'Is this available?',
        answer: 'Yes it is',
        askedBy: 'buyer1',
        askedAt: new Date(1784000000000).toISOString(),
        answeredAt: new Date(1784010000000).toISOString(),
      },
    ]);
    expect(detail.buyNowPrice).toBe(1500);
    expect(detail.reserveStatus).toBe('MET');
    expect(detail.shippingAvailable).toBe(true);
    expect(detail.shippingCost).toBe(5);
    expect(detail.startDate).toBe(new Date(1782954111747).toISOString());
    expect(detail.endDate).toBe(new Date(1783954111747).toISOString());
    expect(detail.categoryPath).toBe('Computers/Laptops');
    expect(detail.photos).toEqual([
      {
        thumbnailUrl: 'https://example.com/thumb1.jpg',
        fullSizeUrl: 'https://example.com/full1.jpg',
      },
    ]);
    expect(detail.seller).toEqual({
      memberId: 42,
      nickname: 'seaf73',
      feedbackCount: 27,
      isTopSeller: true,
      dateJoined: new Date(1600000000000).toISOString(),
    });
    expect(detail.pickupAvailable).toBe(true);
    expect(detail.pickupLocation).toBe('Invercargill, Southland');
  });

  it('returns a well-formed detail object for a completely empty response', () => {
    const detail = parseListingDetailResponse({});
    expect(detail.description).toBe('');
    expect(detail.extraAttributes).toEqual({});
    expect(detail.questionsAndAnswers).toEqual([]);
    expect(detail.buyNowPrice).toBeNull();
    expect(detail.reserveStatus).toBe('NONE');
    expect(detail.shippingAvailable).toBe(false);
    expect(detail.shippingCost).toBeNull();
    expect(Object.hasOwn(detail, 'pickupAvailable')).toBe(false);
    expect(Object.hasOwn(detail, 'pickupLocation')).toBe(false);
    expect(Object.hasOwn(detail, 'startDate')).toBe(false);
    expect(Object.hasOwn(detail, 'endDate')).toBe(false);
    expect(Object.hasOwn(detail, 'categoryPath')).toBe(false);
    expect(Object.hasOwn(detail, 'photos')).toBe(false);
    expect(Object.hasOwn(detail, 'seller')).toBe(false);
  });

  describe('ReserveState mapping', () => {
    it('maps absent to NONE', () => {
      const { ReserveState: _drop, ...rest } = fullListing;
      expect(parseListingDetailResponse(rest).reserveStatus).toBe('NONE');
    });
    it('maps 1 to MET', () => {
      expect(parseListingDetailResponse({ ...fullListing, ReserveState: 1 }).reserveStatus).toBe(
        'MET'
      );
    });
    it('maps 2 to NOT_MET', () => {
      expect(parseListingDetailResponse({ ...fullListing, ReserveState: 2 }).reserveStatus).toBe(
        'NOT_MET'
      );
    });
    it('maps 3 to UNKNOWN (buy-now-only)', () => {
      expect(parseListingDetailResponse({ ...fullListing, ReserveState: 3 }).reserveStatus).toBe(
        'UNKNOWN'
      );
    });
  });

  it('handles a buy-now-only listing (HasBuyNow true, no reserve)', () => {
    const { ReserveState: _drop, ...rest } = fullListing;
    const detail = parseListingDetailResponse({ ...rest, HasBuyNow: true, BuyNowPrice: 999 });
    expect(detail.buyNowPrice).toBe(999);
    expect(detail.reserveStatus).toBe('NONE');
  });

  it('sets buyNowPrice to null when HasBuyNow is false', () => {
    const detail = parseListingDetailResponse({ ...fullListing, HasBuyNow: false });
    expect(detail.buyNowPrice).toBeNull();
  });

  it('returns an empty (but present) questionsAndAnswers array when Questions is absent', () => {
    const { Questions: _drop, ...rest } = fullListing;
    const detail = parseListingDetailResponse(rest);
    expect(Object.hasOwn(detail, 'questionsAndAnswers')).toBe(true);
    expect(detail.questionsAndAnswers).toEqual([]);
  });

  it('returns an empty extraAttributes object when Attributes is absent', () => {
    const { Attributes: _drop, ...rest } = fullListing;
    const detail = parseListingDetailResponse(rest);
    expect(detail.extraAttributes).toEqual({});
  });

  it('returns an empty extraAttributes object when Attributes is an empty array', () => {
    const detail = parseListingDetailResponse({ ...fullListing, Attributes: [] });
    expect(detail.extraAttributes).toEqual({});
  });

  it('sets shippingAvailable=false and shippingCost=null when ShippingOptions is empty', () => {
    const detail = parseListingDetailResponse({ ...fullListing, ShippingOptions: [] });
    expect(detail.shippingAvailable).toBe(false);
    expect(detail.shippingCost).toBeNull();
  });

  it('sets shippingAvailable=false and shippingCost=null when ShippingOptions is absent', () => {
    const { ShippingOptions: _drop, ...rest } = fullListing;
    const detail = parseListingDetailResponse(rest);
    expect(detail.shippingAvailable).toBe(false);
    expect(detail.shippingCost).toBeNull();
  });

  it('sets shippingCost to the minimum Price across multiple shipping options', () => {
    const detail = parseListingDetailResponse({
      ...fullListing,
      ShippingOptions: [{ Price: 20 }, { Price: 5 }, { Price: 12 }],
    });
    expect(detail.shippingCost).toBe(5);
  });

  it('sets shippingAvailable=true and shippingCost=null when ShippingOptions all lack a Price', () => {
    const detail = parseListingDetailResponse({
      ...fullListing,
      ShippingOptions: [{}, {}],
    });
    expect(detail.shippingAvailable).toBe(true);
    expect(detail.shippingCost).toBeNull();
  });

  it('ignores shipping options without a numeric Price when computing the minimum', () => {
    const detail = parseListingDetailResponse({
      ...fullListing,
      ShippingOptions: [{ Price: 20 }, {}, { Price: 12 }],
    });
    expect(detail.shippingCost).toBe(12);
  });

  it('omits seller when Member is absent', () => {
    const { Member: _drop, ...rest } = fullListing;
    const detail = parseListingDetailResponse(rest);
    expect(Object.hasOwn(detail, 'seller')).toBe(false);
  });

  it('omits categoryPath when CategoryPath is absent', () => {
    const { CategoryPath: _drop, ...rest } = fullListing;
    const detail = parseListingDetailResponse(rest);
    expect(Object.hasOwn(detail, 'categoryPath')).toBe(false);
  });

  it('omits photos when Photos is absent', () => {
    const { Photos: _drop, ...rest } = fullListing;
    const detail = parseListingDetailResponse(rest);
    expect(Object.hasOwn(detail, 'photos')).toBe(false);
  });

  it('omits endDate when EndDate is absent', () => {
    const { EndDate: _drop, ...rest } = fullListing;
    const detail = parseListingDetailResponse(rest);
    expect(Object.hasOwn(detail, 'endDate')).toBe(false);
  });

  // AllowsPickups is a small enum, same style as ReserveState — verified empirically
  // against real listings: 1 → pickup offered (co-occurs with a Type:2 "I intend to
  // pick-up" ShippingOptions entry); 3 → not offered (no such entry). There is no
  // dedicated pickup-address field, so pickupLocation reuses the listing's own
  // Suburb/Region, the same source `location` is built from elsewhere.
  describe('AllowsPickups mapping', () => {
    it('maps 1 to pickupAvailable=true with pickupLocation from Suburb/Region', () => {
      const detail = parseListingDetailResponse({ ...fullListing, AllowsPickups: 1 });
      expect(detail.pickupAvailable).toBe(true);
      expect(detail.pickupLocation).toBe('Invercargill, Southland');
    });

    it('maps 3 to pickupAvailable=false with pickupLocation=null', () => {
      const detail = parseListingDetailResponse({ ...fullListing, AllowsPickups: 3 });
      expect(detail.pickupAvailable).toBe(false);
      expect(detail.pickupLocation).toBeNull();
    });

    it('omits pickupAvailable and pickupLocation when AllowsPickups is absent', () => {
      const { AllowsPickups: _drop, ...rest } = fullListing;
      const detail = parseListingDetailResponse(rest);
      expect(Object.hasOwn(detail, 'pickupAvailable')).toBe(false);
      expect(Object.hasOwn(detail, 'pickupLocation')).toBe(false);
    });

    it('omits pickupAvailable and pickupLocation when AllowsPickups is an unrecognized value', () => {
      const detail = parseListingDetailResponse({ ...fullListing, AllowsPickups: 2 });
      expect(Object.hasOwn(detail, 'pickupAvailable')).toBe(false);
      expect(Object.hasOwn(detail, 'pickupLocation')).toBe(false);
    });

    it('returns pickupLocation=null when pickup is available but Suburb/Region are absent', () => {
      const { Suburb: _s, Region: _r, ...rest } = fullListing;
      const detail = parseListingDetailResponse({ ...rest, AllowsPickups: 1 });
      expect(detail.pickupAvailable).toBe(true);
      expect(detail.pickupLocation).toBeNull();
    });
  });
});

// ── fetchSingleListingDetailAsync ─────────────────────────────────────────────

describe('fetchSingleListingDetailAsync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the parsed detail when the listing detail endpoint responds', async () => {
    const rawData = { Body: 'Great laptop', HasBuyNow: false };
    const page = makeDetailPage({ data: rawData }) as unknown as Parameters<
      typeof fetchSingleListingDetailAsync
    >[0];
    const detail = await fetchSingleListingDetailAsync(
      page,
      'https://www.trademe.co.nz/a/listing/12345'
    );
    expect(detail).toEqual(parseListingDetailResponse(rawData));
  });

  it('rejects instead of hanging when no matching response arrives before the timeout', async () => {
    const page = makeDetailPage({ respond: false }) as unknown as Parameters<
      typeof fetchSingleListingDetailAsync
    >[0];
    const detailPromise = fetchSingleListingDetailAsync(
      page,
      'https://www.trademe.co.nz/a/listing/12345'
    );
    const assertion = expect(detailPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(12000);
    await assertion;
  });

  it('rejects immediately on a non-200 response, without waiting for the timeout', async () => {
    const page = makeDetailPage({
      status: 404,
      data: { Body: 'ignored' },
    }) as unknown as Parameters<typeof fetchSingleListingDetailAsync>[0];
    await expect(
      fetchSingleListingDetailAsync(page, 'https://www.trademe.co.nz/a/listing/12345')
    ).rejects.toThrow();
  });

  it('rejects when the response body is not valid JSON', async () => {
    const page = makeDetailPage({ jsonError: true }) as unknown as Parameters<
      typeof fetchSingleListingDetailAsync
    >[0];
    await expect(
      fetchSingleListingDetailAsync(page, 'https://www.trademe.co.nz/a/listing/12345')
    ).rejects.toThrow();
  });
});

// ── extractImplicitFilters ────────────────────────────────────────────────────

describe('extractImplicitFilters', () => {
  it('shows only the last two breadcrumb sections of the category', () => {
    const url = 'https://www.trademe.co.nz/a/marketplace/computers/laptops/search';
    const filters = extractImplicitFilters(url);
    expect(filters).toContainEqual(['Category', 'Computers › Laptops']);
  });

  it('keeps a short category path intact', () => {
    const url = 'https://www.trademe.co.nz/a/marketplace/search';
    const filters = extractImplicitFilters(url);
    expect(filters).toContainEqual(['Category', 'Marketplace']);
  });

  it('extracts the search string without quote marks', () => {
    const url =
      'https://www.trademe.co.nz/a/marketplace/computers/laptops/search?search_string=macbook';
    const filters = extractImplicitFilters(url);
    expect(filters).toContainEqual(['Search', 'macbook']);
  });

  it('prefixes price criteria with a dollar symbol', () => {
    const url = 'https://www.trademe.co.nz/a/marketplace/search?price_min=50&price_max=250';
    const filters = extractImplicitFilters(url);
    expect(filters).toContainEqual(['Price Min', '$50']);
    expect(filters).toContainEqual(['Price Max', '$250']);
  });

  it('returns empty array for invalid URL', () => {
    expect(extractImplicitFilters('not a url')).toEqual([]);
  });
});

// ── buildTrademeUrl ───────────────────────────────────────────────────────────

function entry(slug: string, searchString: string | null = null): DiscoverEntry {
  return { slug, searchString };
}

describe('buildTrademeUrl', () => {
  it('wraps a non-section slug in "marketplace/"', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined, 'used');
    expect(url).toContain('/a/marketplace/computers/laptops/search');
  });

  it('does not prefix a section slug with "marketplace/"', () => {
    const url = buildTrademeUrl(entry('motors/cars'), 0, 'any', undefined, 'used');
    expect(url).toContain('/a/motors/cars/search');
    expect(url).not.toContain('marketplace');
  });

  it('appends search_string when set', () => {
    const url = buildTrademeUrl(entry('computers/laptops', 'macbook'), 0, 'any', undefined, 'used');
    expect(url).toContain('search_string=macbook');
  });

  it('appends price_max when maxPrice > 0', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 500, 'any', undefined, 'used');
    expect(url).toContain('price_max=500');
  });

  it('omits price_max when maxPrice is 0', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined, 'used');
    expect(url).not.toContain('price_max');
  });

  it('adds pickup params when fulfillment is "pickup" and regionValue is set', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'pickup', '2', 'used');
    expect(url).toContain('user_region=2');
    expect(url).toContain('shipping_method=pickup');
  });

  it('does not add pickup params when fulfillment is "pickup" but regionValue is missing', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'pickup', undefined, 'used');
    expect(url).not.toContain('shipping_method');
  });

  it('sets condition=used when condition is "used"', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined, 'used');
    expect(url).toContain('condition=used');
  });

  it('sets condition=new when condition is "new"', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined, 'new');
    expect(url).toContain('condition=new');
  });

  it('produces a search URL with only the condition param when no other params apply', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined, 'used');
    expect(url).toBe(
      'https://www.trademe.co.nz/a/marketplace/computers/laptops/search?condition=used'
    );
  });
});

// ── fetchSearchPage1Async ──────────────────────────────────────────────────────

describe('fetchSearchPage1Async', () => {
  it('returns totalCount, pageSize, and listings from one mocked response', async () => {
    resetPageQueue({
      List: [
        { Title: 'Item', PriceDisplay: '$1', Region: 'Auckland', CanonicalPath: '/listing/1' },
      ],
      TotalCount: 3,
      PageSize: 25,
    });

    const result = await fetchSearchPage1Async(
      'https://www.trademe.co.nz/a/marketplace/search?search_string=lamp'
    );

    expect(result.totalCount).toBe(3);
    expect(result.pageSize).toBe(25);
    expect(result.listings).toHaveLength(1);
  });
});

// ── buildRootMarketplaceSearchUrl ───────────────────────────────────────────────

describe('buildRootMarketplaceSearchUrl', () => {
  it('builds a categoryless marketplace search URL with search_string and condition', () => {
    const url = buildRootMarketplaceSearchUrl('lamp', 0, 'any', undefined, 'used');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/a/marketplace/search');
    expect(parsed.searchParams.get('search_string')).toBe('lamp');
    expect(parsed.searchParams.get('condition')).toBe('used');
  });

  it('never includes a category segment', () => {
    const url = buildRootMarketplaceSearchUrl('lamp', 0, 'any', undefined, 'used');
    expect(new URL(url).pathname).toBe('/a/marketplace/search');
  });

  it('preserves the search string unmodified, including internal spaces', () => {
    const url = buildRootMarketplaceSearchUrl(
      'fisher price music box',
      0,
      'any',
      undefined,
      'used'
    );
    expect(new URL(url).searchParams.get('search_string')).toBe('fisher price music box');
  });

  it('appends price_max when maxPrice > 0', () => {
    const url = buildRootMarketplaceSearchUrl('lamp', 500, 'any', undefined, 'used');
    expect(url).toContain('price_max=500');
  });

  it('omits price_max when maxPrice is 0', () => {
    const url = buildRootMarketplaceSearchUrl('lamp', 0, 'any', undefined, 'used');
    expect(url).not.toContain('price_max');
  });

  it('adds pickup params when fulfillment is "pickup" and regionValue is set', () => {
    const url = buildRootMarketplaceSearchUrl('lamp', 0, 'pickup', '2', 'used');
    expect(url).toContain('user_region=2');
    expect(url).toContain('shipping_method=pickup');
  });

  it('does not add pickup params when fulfillment is "pickup" but regionValue is missing', () => {
    const url = buildRootMarketplaceSearchUrl('lamp', 0, 'pickup', undefined, 'used');
    expect(url).not.toContain('shipping_method');
  });

  it('sets condition=new when condition is "new"', () => {
    const url = buildRootMarketplaceSearchUrl('lamp', 0, 'any', undefined, 'new');
    expect(url).toContain('condition=new');
  });
});

// ── buildDiscoverUrlsAsync ────────────────────────────────────────────────────

describe('buildDiscoverUrlsAsync', () => {
  const MOCK_CATEGORIES: CategoryWithEmbeddingRow[] = [
    { slug: 'electronics/laptops', display: 'Laptops', embedding: JSON.stringify([1, 0]) },
  ];
  const STUB_COOLDOWN_STORE: ProviderCooldownStore = {
    markExhausted: () => {},
    getCooldownUntil: () => undefined,
  };
  const MOCK_AI = {
    url: 'http://example.com',
    model: 'llama',
    apiKey: 'key',
    providerKey: 'mock',
    cooldownStore: STUB_COOLDOWN_STORE,
  };

  function fakeCategoriesWithEmbeddingsStatement(rows: CategoryWithEmbeddingRow[]) {
    return {
      all: () => rows,
    } as unknown as ReturnType<typeof stmtGetAllCategoriesWithEmbeddings>;
  }

  // aiJSON is mocked wholesale in this file, so its calls must resolve with the
  // `AiJsonResult` shape (`{ kind: "ok", value }`) that the real function now
  // returns — see src/server/ai.ts. `applyAiJsonResult` itself is NOT mocked
  // (see the `vi.mock("../ai", ...)` above), so these tests exercise the real
  // unwrap/mark/throw orchestration logic against a faked aiJSON.
  function aiJsonOk(value: unknown) {
    return { kind: 'ok' as const, value };
  }

  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue({} as unknown as Database.Database);
    vi.mocked(stmtGetAllCategoriesWithEmbeddings).mockReturnValue(
      fakeCategoriesWithEmbeddingsStatement(MOCK_CATEGORIES)
    );
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    // buildDiscoverUrlsAsync now fires a root-search probe before AI category
    // selection. Default it to a large TotalCount (well above
    // ROOT_SEARCH_RESULT_THRESHOLD) so tests unrelated to the probe keep
    // exercising the AI-fallback path unchanged; only the 'root search probe'
    // tests below override this with their own resetPageQueue call.
    resetPageQueue({ TotalCount: 5000, PageSize: 100, List: [] });
  });

  // resetAllMocks (not clearAllMocks): strips mock implementations between tests so any test
  // that omits a per-test mockReturnValue gets an explicit undefined rather than a stale return value.
  afterEach(() => vi.resetAllMocks());

  it('returns Trade Me search URLs for AI-selected categories', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
    );

    const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI,
    });
    expect(result.urls.length).toBeGreaterThan(0);
    expect(result.urls.every((u) => u.includes('trademe.co.nz'))).toBe(true);
    expect(result.urls[0]).toContain('electronics/laptops');
  });

  it('applies maxPrice to the generated URL', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
    );

    const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 800,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI,
    });
    expect(result.urls[0]).toContain('price_max=800');
  });

  it('returns an empty warnings array on full success', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
    );

    const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI,
    });
    expect(result.warnings).toEqual([]);
  });

  it('throws when the AI response is null', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk(null));

    await expect(
      trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      })
    ).rejects.toThrow('discover: expected object response with categories array');
  });

  it('throws when the AI response is malformed (missing categories array)', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ notCategories: [] }));

    await expect(
      trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      })
    ).rejects.toThrow('discover: expected object response with categories array');
  });

  it('filters out unrecognised slugs, adds a warning, and continues with valid ones', async () => {
    const TWO_CATEGORIES: CategoryWithEmbeddingRow[] = [
      { slug: 'electronics/laptops', display: 'Laptops', embedding: JSON.stringify([1, 0]) },
      {
        slug: 'computers/laptops',
        display: 'Computer laptops',
        embedding: JSON.stringify([0.9, 0.1]),
      },
    ];
    vi.mocked(stmtGetAllCategoriesWithEmbeddings).mockReturnValue(
      fakeCategoriesWithEmbeddingsStatement(TWO_CATEGORIES)
    );
    // AI returns one valid category and one hallucinated one that doesn't exist in the shortlist
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({
        categories: [
          { slug: 'electronics/laptops', searchString: null },
          { slug: 'hallucinated-slug', searchString: null },
        ],
      })
    );

    const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig: () => MOCK_AI,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('hallucinated-slug');
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain('electronics/laptops');
  });

  it('throws when all AI-selected categories are unrecognised (zero valid slugs)', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({
        categories: [
          { slug: 'hallucinated-a', searchString: null },
          { slug: 'hallucinated-b', searchString: null },
        ],
      })
    );

    await expect(
      trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      })
    ).rejects.toThrow('AI returned no valid categories');
  });

  it('resolves getAiConfig() exactly once for the single AI call', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
    );
    const getAiConfig = vi.fn().mockReturnValue(MOCK_AI);

    await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'any',
      includeSoldItems: false,
      includeNewItems: false,
      getAiConfig,
    });

    expect(getAiConfig).toHaveBeenCalledTimes(1);
  });

  it("marks the resolved config's cooldown store exhausted and propagates the error when the AI call is rate-limited", async () => {
    const markExhausted = vi.fn();
    const rateLimitedAiConfig = {
      ...MOCK_AI,
      cooldownStore: { markExhausted, getCooldownUntil: () => undefined },
    };
    const cooldownUntilMs = Date.now() + 60_000;
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: 'rate-limited',
      providerKey: 'mock',
      cooldownUntilMs,
      message: 'AI rate limited (discover-categories): provider asks to retry',
    });

    await expect(
      trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => rateLimitedAiConfig,
      })
    ).rejects.toThrow('AI rate limited (discover-categories)');

    expect(markExhausted).toHaveBeenCalledWith('mock', cooldownUntilMs);
  });

  describe('root search probe', () => {
    it('returns the root URL only and skips AI category selection when totalCount is small', async () => {
      resetPageQueue({ TotalCount: 6, PageSize: 25, List: [] });

      const result = await trademeRecipe.buildDiscoverUrlsAsync('fisher price music box', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls).toHaveLength(1);
      const url = new URL(result.urls[0]);
      expect(url.pathname).toBe('/a/marketplace/search');
      expect(url.searchParams.get('search_string')).toBe('fisher price music box');
      expect(aiJSON).not.toHaveBeenCalled();
      expect(embedTextAsync).not.toHaveBeenCalled();
    });

    it('falls through to the AI category path when totalCount is zero', async () => {
      resetPageQueue({ TotalCount: 0, PageSize: 25, List: [] });
      vi.mocked(aiJSON).mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
      );

      const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls[0]).toContain('electronics/laptops');
    });

    it('uses the root URL at the threshold boundary (totalCount === 50)', async () => {
      resetPageQueue({ TotalCount: ROOT_SEARCH_RESULT_THRESHOLD, PageSize: 25, List: [] });

      const result = await trademeRecipe.buildDiscoverUrlsAsync('lamp', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls).toHaveLength(1);
      expect(new URL(result.urls[0]).pathname).toBe('/a/marketplace/search');
      expect(aiJSON).not.toHaveBeenCalled();
    });

    it('falls through to the AI category path just above the threshold (totalCount === 51)', async () => {
      resetPageQueue({ TotalCount: ROOT_SEARCH_RESULT_THRESHOLD + 1, PageSize: 25, List: [] });
      vi.mocked(aiJSON).mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
      );

      const result = await trademeRecipe.buildDiscoverUrlsAsync('lamp', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls[0]).toContain('electronics/laptops');
    });

    it('falls back to the AI category path when the probe fetch fails, without throwing', async () => {
      resetPageQueue(PROBE_FETCH_FAILURE);
      vi.mocked(aiJSON).mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
      );

      const result = await trademeRecipe.buildDiscoverUrlsAsync('lamp', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls[0]).toContain('electronics/laptops');
      expect(result.warnings.some((w) => w.includes('root search probe failed'))).toBe(true);
    });

    it('builds both used and new root URLs when includeNewItems is true and the root path wins', async () => {
      resetPageQueue({ TotalCount: 6, PageSize: 25, List: [] });

      const result = await trademeRecipe.buildDiscoverUrlsAsync('fisher price music box', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: true,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls).toHaveLength(2);
      expect(result.urls.some((u) => u.includes('condition=used'))).toBe(true);
      expect(result.urls.some((u) => u.includes('condition=new'))).toBe(true);
      expect(aiJSON).not.toHaveBeenCalled();
    });

    it('skips sold-item URLs and pushes a warning when includeSoldItems is true and the root path wins', async () => {
      resetPageQueue({ TotalCount: 6, PageSize: 25, List: [] });

      const result = await trademeRecipe.buildDiscoverUrlsAsync('fisher price music box', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: true,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls).toHaveLength(1);
      expect(vi.mocked(stmtGetCategoryLegacyPath)).not.toHaveBeenCalled();
      expect(result.warnings.some((w) => w.toLowerCase().includes('sold'))).toBe(true);
    });
  });

  describe('includeSoldItems', () => {
    beforeEach(() => {
      vi.mocked(aiJSON).mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: 'macbook pro' }] })
      );
    });

    it('does not build legacy sold-item URLs when false', async () => {
      const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });
      expect(result.urls).toHaveLength(1);
      expect(vi.mocked(stmtGetCategoryLegacyPath)).not.toHaveBeenCalled();
    });

    it('also builds a legacy sold-item URL per resolved category when true', async () => {
      vi.mocked(stmtGetCategoryLegacyPath).mockReturnValue({
        get: () => ({ legacy_path: '0002-0356-' }) as CategoryLegacyPathRow,
      } as unknown as ReturnType<typeof stmtGetCategoryLegacyPath>);

      const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: true,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls).toHaveLength(2);
      const modernUrl = result.urls.find((u) => u.includes('trademe.co.nz/a/'));
      const legacyUrl = result.urls.find((u) => u.includes('Browse/SearchResults.aspx'));
      expect(modernUrl).toContain('electronics/laptops');
      expect(legacyUrl).toContain('cid=356');
      expect(legacyUrl).toContain('rptpath=2-356-');
    });

    it('warns instead of throwing when a resolved category has no legacy mapping', async () => {
      vi.mocked(stmtGetCategoryLegacyPath).mockReturnValue({
        get: () => undefined,
      } as unknown as ReturnType<typeof stmtGetCategoryLegacyPath>);

      const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: true,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls).toHaveLength(1); // modern URL only
      expect(result.warnings.some((w) => w.includes('no legacy category mapping'))).toBe(true);
    });
  });

  describe('includeNewItems', () => {
    beforeEach(() => {
      vi.mocked(aiJSON).mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: 'macbook pro' }] })
      );
    });

    it('builds a single condition=used URL per resolved category when false', async () => {
      const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: false,
        getAiConfig: () => MOCK_AI,
      });
      expect(result.urls).toHaveLength(1);
      expect(result.urls[0]).toContain('condition=used');
    });

    it('also builds a condition=new URL per resolved category when true', async () => {
      const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: false,
        includeNewItems: true,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls).toHaveLength(2);
      const usedUrl = result.urls.find((u) => u.includes('condition=used'));
      const newUrl = result.urls.find((u) => u.includes('condition=new'));
      expect(usedUrl).toContain('electronics/laptops');
      expect(newUrl).toContain('electronics/laptops');
    });

    it('combines with includeSoldItems: builds used, new, and legacy sold URLs when both true', async () => {
      vi.mocked(stmtGetCategoryLegacyPath).mockReturnValue({
        get: () => ({ legacy_path: '0002-0356-' }) as CategoryLegacyPathRow,
      } as unknown as ReturnType<typeof stmtGetCategoryLegacyPath>);

      const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        includeSoldItems: true,
        includeNewItems: true,
        getAiConfig: () => MOCK_AI,
      });

      expect(result.urls).toHaveLength(3);
      expect(result.urls.some((u) => u.includes('condition=used'))).toBe(true);
      expect(result.urls.some((u) => u.includes('condition=new'))).toBe(true);
      expect(result.urls.some((u) => u.includes('Browse/SearchResults.aspx'))).toBe(true);
    });
  });
});

// ── quickSearch multi-page accumulation ───────────────────────────────────────

describe('quickSearch', () => {
  it('emits listings from all pages when results span multiple pages', async () => {
    const makeItem = (i: number) => ({
      Title: `Item ${i}`,
      PriceDisplay: '$1',
      Region: 'Auckland',
      CanonicalPath: `/listing/${i}`,
    });

    resetPageQueue(
      { List: Array.from({ length: 22 }, (_, i) => makeItem(i + 1)), TotalCount: 27, PageSize: 22 },
      { List: Array.from({ length: 5 }, (_, i) => makeItem(i + 23)), TotalCount: 27, PageSize: 22 }
    );

    const collected: unknown[] = [];
    await trademeRecipe.quickSearchAsync(
      'https://www.trademe.co.nz/a/marketplace/computers/search',
      (ev) => {
        if (ev.type === 'listing') collected.push(ev.data);
      }
    );

    expect(collected).toHaveLength(27);
  });

  it('caps emitted listings at MAX_RESULTS_PER_URL when totalCount exceeds it', async () => {
    const makeItem = (i: number) => ({
      Title: `Item ${i}`,
      PriceDisplay: '$1',
      Region: 'Auckland',
      CanonicalPath: `/listing/${i}`,
    });

    const pageSize = 40;
    resetPageQueue(
      ...Array.from({ length: 5 }, (_, pageIndex) => ({
        List: Array.from({ length: pageSize }, (_, i) => makeItem(pageIndex * pageSize + i + 1)),
        TotalCount: 200,
        PageSize: pageSize,
      }))
    );

    const collected: unknown[] = [];
    await trademeRecipe.quickSearchAsync(
      'https://www.trademe.co.nz/a/marketplace/computers/search',
      (ev) => {
        if (ev.type === 'listing') collected.push(ev.data);
      }
    );

    expect(collected).toHaveLength(100);
  });
});

// ── quickSearchAsync (domain concurrency limiting) ────────────────────────────
//
// A discover request can fan out several concurrent TradeMe search URLs per
// category (used/new/sold), and adding "include new items" pushes the
// worst-case concurrent-launch count higher still — so the initial browser
// launch must be routed through the same per-domain limiter that pagination
// already uses, exactly like Facebook's quickSearchAsync.

describe('trademeRecipe.quickSearchAsync — domain concurrency limiting', () => {
  beforeEach(() => {
    resetPageQueue();
    browserSessionTracker.reset();
    enqueuedUrls.length = 0;
  });

  it('routes the browser launch through the domain limiter, keyed by the search URL', async () => {
    const searchUrl = 'https://www.trademe.co.nz/a/marketplace/computers/search?search_string=lamp';

    await trademeRecipe.quickSearchAsync(searchUrl, () => {});

    expect(enqueuedUrls).toContain(searchUrl);
  });

  it('never exceeds the trademe.co.nz domain concurrency limit across concurrent searches', async () => {
    // trademe.co.nz's domain limit is 3 (src/lib/queue.ts). Fire 5 concurrent
    // single-page searches — comfortably more than the limit — and verify the
    // limiter, not just pagination, is what gates the launches. Before the
    // fix, chromium.launch() ran outside enqueue entirely, so all 5 would
    // launch at once (maxActiveCount === 5).
    const searchUrls = Array.from(
      { length: 5 },
      (_, i) => `https://www.trademe.co.nz/a/marketplace/computers/search?search_string=item${i}`
    );

    await Promise.all(searchUrls.map((url) => trademeRecipe.quickSearchAsync(url, () => {})));

    expect(browserSessionTracker.maxActiveCount).toBe(3);
  });
});
