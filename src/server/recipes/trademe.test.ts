import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing, ProviderCooldownStore } from '../../lib/recipes/base';
import { aiJSON } from '../ai';
import { type CategoryRow, getDb, stmtGetCategoriesAtDepth2, stmtGetCategoriesByTop2 } from '../db';
import {
  buildListing,
  buildPhotosFromUrls,
  buildTrademeUrl,
  collapseEntries,
  type DiscoverEntry,
  extractImplicitFilters,
  fetchSingleListingDetailAsync,
  mapReserveState,
  parseListingDetailResponse,
  parseSearchApiResponse,
  parseTradeMeDate,
  STEP2_SYSTEM_PROMPT,
  trademeRecipe,
} from './trademe';

// `applyAiJsonResult` is left as the real implementation (not mocked) so these tests
// exercise the actual orchestration logic — unwrapping an ok result, or marking the
// cooldown store and throwing for a rate-limited one — with only `aiJSON` faked.
vi.mock('../ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai')>();
  return { ...actual, aiJSON: vi.fn() };
});
vi.mock('../db', () => ({
  getDb: vi.fn(),
  stmtGetCategoriesAtDepth2: vi.fn(),
  stmtGetCategoriesByTop2: vi.fn(),
}));

// ── Playwright mock for quickSearch integration tests ─────────────────────────

const { getNextPage, resetPageQueue, makeDetailPage } = vi.hoisted(() => {
  const queue: unknown[] = [];

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

  return {
    getNextPage: () => makePage(queue.shift() ?? {}),
    resetPageQueue: (...items: unknown[]) => {
      queue.splice(0, queue.length, ...items);
    },
    makeDetailPage,
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      newContext: async () => ({ newPage: async () => getNextPage() }),
      close: async () => {},
    }),
  },
}));

vi.mock('../../lib/queue', () => ({
  enqueue: (_: string, fn: () => Promise<unknown>) => fn(),
}));

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

// ── STEP2_SYSTEM_PROMPT ───────────────────────────────────────────────────────

describe('STEP2_SYSTEM_PROMPT', () => {
  it('contains the required JSON schema keywords for the AI response contract', () => {
    expect(STEP2_SYSTEM_PROMPT).toContain('"categories"');
    expect(STEP2_SYSTEM_PROMPT).toContain('"slug"');
    expect(STEP2_SYSTEM_PROMPT).toContain('"searchString"');
  });

  it('instructs the AI to return JSON', () => {
    expect(STEP2_SYSTEM_PROMPT).toContain('Return JSON');
  });
});

// ── collapseEntries ───────────────────────────────────────────────────────────

function entry(slug: string, searchString: string | null = null): DiscoverEntry {
  return { slug, searchString };
}

describe('collapseEntries', () => {
  it('returns an empty array unchanged', () => {
    expect(collapseEntries([])).toEqual([]);
  });

  it('passes through a single entry with no siblings', () => {
    const input = [entry('computers/laptops/apple')];
    expect(collapseEntries(input)).toEqual(input);
  });

  it('drops a child when its parent is also present in the list', () => {
    const input = [entry('computers/laptops'), entry('computers/laptops/apple')];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('computers/laptops');
  });

  it('collapses two siblings with the same searchString to their parent', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'macbook'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ slug: 'marketplace/computers/laptops', searchString: 'macbook' });
  });

  it('does not collapse siblings when their shared parent slug has fewer than 3 segments', () => {
    const input = [
      entry('computers/laptops/apple', 'macbook'),
      entry('computers/laptops/dell', 'macbook'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
  });

  it('does not collapse siblings with different searchStrings', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'latitude'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
  });

  it('does not collapse a lone entry with no siblings', () => {
    const input = [entry('marketplace/computers/laptops/apple', 'macbook')];
    expect(collapseEntries(input)).toEqual(input);
  });

  it('collapses three siblings to one parent entry', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', null),
      entry('marketplace/computers/laptops/dell', null),
      entry('marketplace/computers/laptops/lenovo', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ slug: 'marketplace/computers/laptops', searchString: null });
  });

  it('collapses one sibling group and leaves unrelated entries untouched', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'macbook'),
      entry('marketplace/electronics/cameras/dslr', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
    const slugs = result.map((e) => e.slug);
    expect(slugs).toContain('marketplace/computers/laptops');
    expect(slugs).toContain('marketplace/electronics/cameras/dslr');
  });

  it('does not emit the collapsed parent slug twice when three siblings collapse', () => {
    const input = [
      entry('marketplace/furniture/home/bedroom', null),
      entry('marketplace/furniture/home/living', null),
      entry('marketplace/furniture/home/dining', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('marketplace/furniture/home');
  });

  it('does not collapse siblings when their parent is present in the input', () => {
    const input = [
      entry('marketplace/furniture/home'),
      entry('marketplace/furniture/home/bedroom', null),
      entry('marketplace/furniture/home/living', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('marketplace/furniture/home');
  });

  it('collapses two independent sibling groups under separate parents without merging them', () => {
    // Regression guard: collapsing siblings in one group must not affect siblings in an
    // unrelated group that shares no ancestor. Each group produces its own parent entry.
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'macbook'),
      entry('marketplace/furniture/home/bedroom', null),
      entry('marketplace/furniture/home/living', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
    const slugs = result.map((e) => e.slug);
    expect(slugs).toContain('marketplace/computers/laptops');
    expect(slugs).toContain('marketplace/furniture/home');
    const laptops = result.find((e) => e.slug === 'marketplace/computers/laptops');
    const home = result.find((e) => e.slug === 'marketplace/furniture/home');
    expect(laptops?.searchString).toBe('macbook');
    expect(home?.searchString).toBeNull();
  });
});

// ── buildTrademeUrl ───────────────────────────────────────────────────────────

describe('buildTrademeUrl', () => {
  it('wraps a non-section slug in "marketplace/"', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined);
    expect(url).toContain('/a/marketplace/computers/laptops/search');
  });

  it('does not prefix a section slug with "marketplace/"', () => {
    const url = buildTrademeUrl(entry('motors/cars'), 0, 'any', undefined);
    expect(url).toContain('/a/motors/cars/search');
    expect(url).not.toContain('marketplace');
  });

  it('appends search_string when set', () => {
    const url = buildTrademeUrl(entry('computers/laptops', 'macbook'), 0, 'any', undefined);
    expect(url).toContain('search_string=macbook');
  });

  it('appends price_max when maxPrice > 0', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 500, 'any', undefined);
    expect(url).toContain('price_max=500');
  });

  it('omits price_max when maxPrice is 0', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined);
    expect(url).not.toContain('price_max');
  });

  it('adds pickup params when fulfillment is "pickup" and regionValue is set', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'pickup', '2');
    expect(url).toContain('user_region=2');
    expect(url).toContain('shipping_method=pickup');
  });

  it('does not add pickup params when fulfillment is "pickup" but regionValue is missing', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'pickup', undefined);
    expect(url).not.toContain('shipping_method');
  });

  it('produces a bare search URL when no params apply', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined);
    expect(url).toBe('https://www.trademe.co.nz/a/marketplace/computers/laptops/search');
  });
});

// ── buildDiscoverUrlsAsync ────────────────────────────────────────────────────

describe('buildDiscoverUrlsAsync', () => {
  const MOCK_BROAD = [{ display: 'Electronics', slug: 'electronics/electronics' }];
  const MOCK_SUBS = [{ display: 'Laptops', slug: 'electronics/laptops' }];
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

  function fakeCategoriesAtDepth2Statement(rows: CategoryRow[]) {
    return { all: () => rows } as unknown as ReturnType<typeof stmtGetCategoriesAtDepth2>;
  }

  function fakeCategoriesByTop2Statement(all: (top2Slug: string) => CategoryRow[]) {
    return { all } as unknown as ReturnType<typeof stmtGetCategoriesByTop2>;
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
    vi.mocked(stmtGetCategoriesAtDepth2).mockReturnValue(
      fakeCategoriesAtDepth2Statement(MOCK_BROAD)
    );
    vi.mocked(stmtGetCategoriesByTop2).mockReturnValue(
      fakeCategoriesByTop2Statement((top2Slug) => {
        expect(top2Slug).toBe('electronics/electronics');
        return MOCK_SUBS;
      })
    );
  });

  // resetAllMocks (not clearAllMocks): strips mock implementations between tests so any test
  // that omits a per-test mockReturnValue gets an explicit undefined rather than a stale return value.
  afterEach(() => vi.resetAllMocks());

  it('returns Trade Me search URLs for AI-selected categories', async () => {
    vi.mocked(aiJSON)
      .mockResolvedValueOnce(
        aiJsonOk({
          categories: ['Electronics'],
          searchLabel: 'laptops',
          searchQuery: 'laptop',
        })
      )
      .mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
      );

    const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'any',
      getAiConfig: () => MOCK_AI,
    });
    expect(result.urls.length).toBeGreaterThan(0);
    expect(result.urls.every((u) => u.includes('trademe.co.nz'))).toBe(true);
    expect(result.urls[0]).toContain('electronics/laptops');
  });

  it('applies maxPrice to the generated URL', async () => {
    vi.mocked(aiJSON)
      .mockResolvedValueOnce(
        aiJsonOk({
          categories: ['Electronics'],
          searchLabel: 'l',
          searchQuery: 'laptop',
        })
      )
      .mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
      );

    const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 800,
      fulfillment: 'any',
      getAiConfig: () => MOCK_AI,
    });
    expect(result.urls[0]).toContain('price_max=800');
  });

  it('returns an empty warnings array on full success', async () => {
    vi.mocked(aiJSON)
      .mockResolvedValueOnce(
        aiJsonOk({
          categories: ['Electronics'],
          searchLabel: 'l',
          searchQuery: 'laptop',
        })
      )
      .mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
      );

    const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'any',
      getAiConfig: () => MOCK_AI,
    });
    expect(result.warnings).toEqual([]);
  });

  it('accumulates a warning for a step-2 null response and throws only when no URLs result', async () => {
    vi.mocked(aiJSON)
      .mockResolvedValueOnce(
        aiJsonOk({
          categories: ['Electronics'],
          searchLabel: 'l',
          searchQuery: 'laptop',
        })
      )
      .mockResolvedValueOnce(aiJsonOk(null));

    await expect(
      trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        getAiConfig: () => MOCK_AI,
      })
    ).rejects.toThrow('AI returned no valid specific categories');
  });

  it('preserves valid categories from other step-2 calls when one returns null', async () => {
    const MOCK_TWO_BROAD = [
      { display: 'Electronics', slug: 'electronics/electronics' },
      { display: 'Computers', slug: 'computers/computers' },
    ];
    const MOCK_TWO_SUBS = [{ display: 'Laptops', slug: 'computers/laptops' }];
    vi.mocked(stmtGetCategoriesAtDepth2).mockReturnValue(
      fakeCategoriesAtDepth2Statement(MOCK_TWO_BROAD)
    );
    vi.mocked(stmtGetCategoriesByTop2).mockReturnValue(
      fakeCategoriesByTop2Statement((top2Slug) => {
        expect(['electronics/electronics', 'computers/computers']).toContain(top2Slug);
        return MOCK_TWO_SUBS;
      })
    );
    vi.mocked(aiJSON)
      .mockResolvedValueOnce(
        aiJsonOk({
          categories: ['Electronics', 'Computers'],
          searchLabel: 'laptops',
          searchQuery: 'laptop',
        })
      )
      .mockResolvedValueOnce(aiJsonOk(null))
      .mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'computers/laptops', searchString: null }] })
      );

    const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'any',
      getAiConfig: () => MOCK_AI,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('step2:electronics/electronics');
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain('computers/laptops');
  });

  it('accumulates a warning for a step-2 malformed response and throws only when no URLs result', async () => {
    vi.mocked(aiJSON)
      .mockResolvedValueOnce(
        aiJsonOk({
          categories: ['Electronics'],
          searchLabel: 'l',
          searchQuery: 'laptop',
        })
      )
      .mockResolvedValueOnce(aiJsonOk({ notCategories: [] }));

    await expect(
      trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        getAiConfig: () => MOCK_AI,
      })
    ).rejects.toThrow('AI returned no valid specific categories');
  });

  it('filters out unrecognised step-1 slugs, adds a warning, and continues with valid ones', async () => {
    const MOCK_TWO_BROAD = [
      { display: 'Electronics', slug: 'electronics/electronics' },
      { display: 'Computers', slug: 'computers/computers' },
    ];
    const MOCK_TWO_SUBS = [{ display: 'Laptops', slug: 'electronics/laptops' }];
    vi.mocked(stmtGetCategoriesAtDepth2).mockReturnValue(
      fakeCategoriesAtDepth2Statement(MOCK_TWO_BROAD)
    );
    vi.mocked(stmtGetCategoriesByTop2).mockReturnValue(
      fakeCategoriesByTop2Statement((top2Slug) => {
        expect(top2Slug).toBe('electronics/electronics');
        return MOCK_TWO_SUBS;
      })
    );
    // AI returns one valid category and one hallucinated one that doesn't exist in MOCK_TWO_BROAD
    vi.mocked(aiJSON)
      .mockResolvedValueOnce(
        aiJsonOk({
          categories: ['Electronics', 'Hallucinated Category'],
          searchLabel: 'laptops',
          searchQuery: 'laptop',
        })
      )
      .mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
      );

    const result = await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'any',
      getAiConfig: () => MOCK_AI,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Hallucinated Category');
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain('electronics/laptops');
  });

  it('throws when all step-1 categories are unrecognised (zero valid slugs)', async () => {
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({
        categories: ['Hallucinated Category A', 'Hallucinated Category B'],
        searchLabel: 'laptops',
        searchQuery: 'laptop',
      })
    );

    await expect(
      trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        getAiConfig: () => MOCK_AI,
      })
    ).rejects.toThrow('AI returned no valid broad categories');
  });

  it('re-resolves getAiConfig() before each step-2 call, so a rotated provider is used for later slugs', async () => {
    const MOCK_TWO_BROAD = [
      { display: 'Electronics', slug: 'electronics/electronics' },
      { display: 'Computers', slug: 'computers/computers' },
    ];
    const MOCK_TWO_SUBS = [{ display: 'Laptops', slug: 'electronics/laptops' }];
    vi.mocked(stmtGetCategoriesAtDepth2).mockReturnValue(
      fakeCategoriesAtDepth2Statement(MOCK_TWO_BROAD)
    );
    vi.mocked(stmtGetCategoriesByTop2).mockReturnValue(
      fakeCategoriesByTop2Statement(() => MOCK_TWO_SUBS)
    );
    vi.mocked(aiJSON)
      .mockResolvedValueOnce(
        aiJsonOk({
          categories: ['Electronics', 'Computers'],
          searchLabel: 'laptops',
          searchQuery: 'laptop',
        })
      )
      .mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
      )
      .mockResolvedValueOnce(
        aiJsonOk({ categories: [{ slug: 'electronics/laptops', searchString: null }] })
      );

    const ROTATED_AI = { ...MOCK_AI, providerKey: 'rotated' };
    const getAiConfig = vi
      .fn()
      .mockReturnValueOnce(MOCK_AI) // step 1
      .mockReturnValueOnce(MOCK_AI) // step 2, first slug
      .mockReturnValueOnce(ROTATED_AI); // step 2, second slug — provider rotated mid-pipeline

    await trademeRecipe.buildDiscoverUrlsAsync('laptop', {
      maxPrice: 0,
      fulfillment: 'any',
      getAiConfig,
    });

    expect(getAiConfig).toHaveBeenCalledTimes(3);
    expect(vi.mocked(aiJSON).mock.calls[1][0]).toBe(MOCK_AI);
    expect(vi.mocked(aiJSON).mock.calls[2][0]).toBe(ROTATED_AI);
  });

  it("marks the resolved config's cooldown store exhausted and propagates the error when step1 is rate-limited", async () => {
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
      message: 'AI rate limited (step1): provider asks to retry',
    });

    await expect(
      trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        getAiConfig: () => rateLimitedAiConfig,
      })
    ).rejects.toThrow('AI rate limited (step1)');

    expect(markExhausted).toHaveBeenCalledWith('mock', cooldownUntilMs);
  });

  it("marks the resolved config's cooldown store exhausted and propagates the error when a step2 call is rate-limited", async () => {
    const markExhausted = vi.fn();
    const rateLimitedAiConfig = {
      ...MOCK_AI,
      cooldownStore: { markExhausted, getCooldownUntil: () => undefined },
    };
    const cooldownUntilMs = Date.now() + 60_000;
    vi.mocked(aiJSON)
      .mockResolvedValueOnce(
        aiJsonOk({
          categories: ['Electronics'],
          searchLabel: 'laptops',
          searchQuery: 'laptop',
        })
      )
      .mockResolvedValueOnce({
        kind: 'rate-limited',
        providerKey: 'mock',
        cooldownUntilMs,
        message: 'AI rate limited (step2:electronics/electronics): provider asks to retry',
      });

    await expect(
      trademeRecipe.buildDiscoverUrlsAsync('laptop', {
        maxPrice: 0,
        fulfillment: 'any',
        getAiConfig: () => rateLimitedAiConfig,
      })
    ).rejects.toThrow('AI rate limited (step2:electronics/electronics)');

    expect(markExhausted).toHaveBeenCalledWith('mock', cooldownUntilMs);
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
