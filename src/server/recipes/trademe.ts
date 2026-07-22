import { type BrowserContext, chromium, type Page, type Response } from 'playwright';
import { enqueue } from '../../lib/queue';
import type {
  DeepSearchDetail,
  DeepSearchEvent,
  DiscoverableRecipe,
  DiscoverContext,
  Fulfillment,
  Listing,
  ListingCondition,
  ListingPhoto,
  QuickSearchEvent,
  RecipeDiscoverResult,
  ReserveStatus,
} from '../../lib/recipes/base';
import { requirePattern } from '../../lib/recipes/metadata';
import { hashFingerprintParts } from '../alerts';
import { getSharedBrowserAsync } from '../browserPool';
import {
  MAX_PAGES_PER_SEARCH,
  MAX_RESULTS_PER_URL,
  ROOT_SEARCH_COMBINED_RESULT_THRESHOLD,
  ROOT_SEARCH_RESULT_THRESHOLD,
} from '../constants';
import { getDb, stmtGetCategoryLegacyPath } from '../db';
import { type DiscoverEntry, resolveDiscoverCategoriesAsync } from './trademeCategoryResolver';
import { buildLegacySearchUrl, buildRootLegacySearchUrl } from './trademeExpired';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TRADEME_BASE = 'https://www.trademe.co.nz/a';

const TRADEME_PATTERN = requirePattern('trademe');

type ApiItem = Record<string, unknown>;

// ── Implicit filter extraction ────────────────────────────────────────────────

const DISPLAY_NAME_BY_PARAM_NAME: Record<string, string> = {
  search_string: 'Search',
  condition: 'Condition',
  sort_order: 'Sort',
};

const LABEL_BY_PANEL_HASH: Record<string, string> = {
  '5c34c1efa0ac468f91e15161d549c479': 'RAM',
  '7a2bb94c0cb44806ac995a4fc854bcbc': 'Screen Size',
};

const IGNORED_PARAM_NAMES = new Set([
  'rows',
  'page',
  'return_canonical',
  'return_metadata',
  'return_ads',
  'return_empty_categories',
  'return_super_features',
  'return_did_you_mean',
  'return_variants',
  'snap_parameters',
  'preferred_shipping_location',
  'return_parameter_counts',
]);

export function extractImplicitFilters(urlStr: string): Array<[string, string]> {
  try {
    const url = new URL(urlStr);
    const filterRows: Array<[string, string]> = [];

    const pathMatch = url.pathname.match(/\/a\/(.+?)\/search/);
    if (pathMatch) {
      // Only the last two breadcrumb sections — deep paths are noise on screen.
      const cat = pathMatch[1]
        .split('/')
        .slice(-2)
        .map((pathSegment) =>
          pathSegment
            .split('-')
            .map((word) => word[0].toUpperCase() + word.slice(1))
            .join(' ')
        )
        .join(' › ');
      filterRows.push(['Category', cat]);
    }

    const grouped: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams.entries()) {
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(v);
    }

    for (const [key, vals] of Object.entries(grouped)) {
      if (IGNORED_PARAM_NAMES.has(key)) continue;

      if (key in DISPLAY_NAME_BY_PARAM_NAME) {
        let filterValue = vals.join(', ');
        if (key === 'condition') filterValue = filterValue[0].toUpperCase() + filterValue.slice(1);
        filterRows.push([DISPLAY_NAME_BY_PARAM_NAME[key], filterValue]);
        continue;
      }

      if (key === 'price_min' || key === 'price_max') {
        const label = key === 'price_min' ? 'Price Min' : 'Price Max';
        filterRows.push([label, `$${vals.join(', $')}`]);
        continue;
      }

      if (key.startsWith('RefinePanel')) {
        const hash = key.replace('RefinePanel', '');
        let label = LABEL_BY_PANEL_HASH[hash];
        if (!label) {
          if (vals.some((paramValue) => paramValue.toLowerCase().includes('gb'))) label = 'RAM';
          else if (vals.some((paramValue) => paramValue.includes('"'))) label = 'Screen Size';
          else label = 'Filter';
        }
        filterRows.push([label, vals.join(', ')]);
        continue;
      }

      const label = key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
      filterRows.push([label, vals.join(', ')]);
    }

    return filterRows;
  } catch {
    return [];
  }
}

// ── Price helpers ──────────────────────────────────────────────────────────────

export function parsePriceValue(display: string): number | null {
  const match = String(display)
    .replace(/,/g, '')
    .match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

// ── Field mapping helpers ──────────────────────────────────────────────────────

// Empirically verified against real listings: absent → no reserve; 1 → met;
// 2 → not met; 3 is not really a reserve state at all — it's always paired with
// IsBuyNowOnly, i.e. the listing isn't an auction, so the frontend never renders it.
export function mapReserveState(reserveState: number | undefined): ReserveStatus {
  if (reserveState === undefined) return 'NONE';
  if (reserveState === 1) return 'MET';
  if (reserveState === 2) return 'NOT_MET';
  return 'UNKNOWN';
}

const TRADEME_WIRE_DATE_PATTERN = /^\/Date\((\d+)\)\/$/;

// Normalizes TradeMe's `/Date(ms)/` wire format to ISO 8601 at the parsing boundary.
export function parseTradeMeDate(wireValue: string | undefined): string | undefined {
  if (!wireValue) return undefined;
  const match = wireValue.match(TRADEME_WIRE_DATE_PATTERN);
  if (!match) return undefined;
  return new Date(Number(match[1])).toISOString();
}

export function buildPhotosFromUrls(photoUrls: string[] | undefined): ListingPhoto[] | undefined {
  if (!photoUrls || photoUrls.length === 0) return undefined;
  return photoUrls.map((url) => ({
    thumbnailUrl: url,
    fullSizeUrl: url.replace('/photoserver/thumb/', '/photoserver/full/'),
  }));
}

// ── API response parsing ──────────────────────────────────────────────────────

export type RawApiItem = {
  title: string;
  priceDisplay: string;
  suburb?: string;
  region?: string;
  canonicalPath: string;
  pictureHref?: string;
  isBuyNowOnly: boolean;
  hasBuyNow: boolean;
  buyNowPrice?: number;
  reserveState?: number;
  startDate?: string;
  endDate?: string;
  categoryPath?: string;
  photoUrls?: string[];
  memberId?: number;
  isSuperSeller?: boolean;
  shippingCost?: number;
};

export function buildListing(raw: RawApiItem): Listing | null {
  const url = raw.canonicalPath ? `${TRADEME_BASE}${raw.canonicalPath}` : '';
  if (!raw.title || !url) return null;

  const listing: Listing = {
    source: TRADEME_PATTERN.name,
    title: raw.title,
    price: parsePriceValue(raw.priceDisplay),
    location: [raw.suburb, raw.region].filter(Boolean).join(', ') || 'Unknown',
    url,
    thumbnailUrl: raw.pictureHref?.replace('/photoserver/thumb/', '/photoserver/full/'),
    isAuction: !raw.isBuyNowOnly,
    reserveStatus: mapReserveState(raw.reserveState),
    relevance: 0,
  };

  if (raw.hasBuyNow) listing.buyNowPrice = raw.buyNowPrice ?? null;

  const startDate = parseTradeMeDate(raw.startDate);
  if (startDate) listing.startDate = startDate;
  const endDate = parseTradeMeDate(raw.endDate);
  if (endDate) listing.endDate = endDate;

  if (raw.categoryPath) listing.categoryPath = raw.categoryPath;

  const photos = buildPhotosFromUrls(raw.photoUrls);
  if (photos) listing.photos = photos;

  if (raw.shippingCost !== undefined) listing.shippingCost = raw.shippingCost;

  if (raw.memberId != null) {
    listing.seller = { memberId: raw.memberId, isTopSeller: raw.isSuperSeller ?? false };
  }

  return listing;
}

function extractSuggestedShippingPrice(item: ApiItem): number | undefined {
  const shippingDetails = item.ShippingDetails as ApiItem | undefined;
  const suggestedShipping = shippingDetails?.SuggestedShipping as ApiItem | undefined;
  return suggestedShipping?.Price as number | undefined;
}

export function parseSearchApiResponse(data: Record<string, unknown>): {
  listings: Listing[];
  totalCount: number;
  pageSize: number;
} {
  const items = (data?.List ?? []) as ApiItem[];
  const totalCount = (data?.TotalCount as number) ?? 0;
  const pageSize = (data?.PageSize as number) || items.length || 1;
  const listings = items
    .map(
      (item): RawApiItem => ({
        title: (item.Title as string) ?? '',
        priceDisplay: (item.PriceDisplay as string) ?? '',
        suburb: item.Suburb as string | undefined,
        region: item.Region as string | undefined,
        canonicalPath: (item.CanonicalPath as string) ?? '',
        pictureHref: (item.PictureHref as string) || undefined,
        isBuyNowOnly: Boolean(item.IsBuyNowOnly),
        hasBuyNow: Boolean(item.HasBuyNow),
        buyNowPrice: item.BuyNowPrice as number | undefined,
        reserveState: item.ReserveState as number | undefined,
        startDate: item.StartDate as string | undefined,
        endDate: item.EndDate as string | undefined,
        categoryPath: item.CategoryPath as string | undefined,
        photoUrls: item.PhotoUrls as string[] | undefined,
        memberId: item.MemberId as number | undefined,
        isSuperSeller: item.IsSuperSeller as boolean | undefined,
        shippingCost: extractSuggestedShippingPrice(item),
      })
    )
    .map(buildListing)
    .filter((listing): listing is Listing => listing !== null);
  return { listings, totalCount, pageSize };
}

// ── Listing detail response parsing ───────────────────────────────────────────
// Parses GET api.trademe.co.nz/v1/listings/{id}.json, the REST endpoint the
// listing page itself calls — the sole source for deep search.

type RawAttribute = { Name?: string; Value?: string; DisplayValue?: string };
type RawQuestion = {
  Comment?: string;
  Answer?: string;
  AskingMember?: { Nickname?: string };
  CommentDate?: string;
  AnswerDate?: string;
};
type RawShippingOption = { Price?: number };
type RawPhoto = { Value?: { Thumbnail?: string; FullSize?: string } };
type RawMember = {
  MemberId?: number;
  Nickname?: string;
  FeedbackCount?: number;
  IsTopSeller?: boolean;
  DateJoined?: string;
};

function extractExtraAttributes(rawAttributes: RawAttribute[] | undefined): Record<string, string> {
  const extraAttributes: Record<string, string> = {};
  for (const attribute of rawAttributes ?? []) {
    if (!attribute.Name) continue;
    extraAttributes[attribute.Name] = attribute.DisplayValue ?? attribute.Value ?? '';
  }
  return extraAttributes;
}

function extractQuestionsAndAnswersFromApi(
  rawQuestions: RawQuestion[] | undefined
): NonNullable<DeepSearchDetail['questionsAndAnswers']> {
  return (rawQuestions ?? []).map((question) => ({
    question: question.Comment ?? '',
    answer: question.Answer ?? '',
    askedBy: question.AskingMember?.Nickname,
    askedAt: parseTradeMeDate(question.CommentDate),
    answeredAt: question.Answer ? parseTradeMeDate(question.AnswerDate) : undefined,
  }));
}

export function parseListingDetailResponse(data: Record<string, unknown>): DeepSearchDetail {
  const shippingOptions = (data.ShippingOptions ?? []) as RawShippingOption[];
  const shippingPrices = shippingOptions
    .map((option) => option.Price)
    .filter((price): price is number => typeof price === 'number');
  const hasBuyNow = Boolean(data.HasBuyNow);

  const detail: DeepSearchDetail = {
    description: String(data.Body ?? ''),
    extraAttributes: extractExtraAttributes(data.Attributes as RawAttribute[] | undefined),
    questionsAndAnswers: extractQuestionsAndAnswersFromApi(
      (data.Questions as { List?: RawQuestion[] } | undefined)?.List
    ),
    buyNowPrice: hasBuyNow ? Number(data.BuyNowPrice) : null,
    reserveStatus: mapReserveState(data.ReserveState as number | undefined),
    // shippingAvailable reflects raw option presence, not shippingPrices: options
    // that exist but omit a numeric Price still mean shipping is available, just
    // with an unknown cost.
    shippingAvailable: shippingOptions.length > 0,
    shippingCost: shippingPrices.length > 0 ? Math.min(...shippingPrices) : null,
  };

  // AllowsPickups is a small enum, same style as ReserveState — verified empirically
  // against real listings: 1 means pickup is offered, 3 means the seller explicitly
  // doesn't allow it. When the field is absent, TradeMe hasn't told us either way —
  // that's different from an explicit refusal, so leave both keys unset (omission
  // convention, see DeepSearchDetail) rather than defaulting to "not available".
  if (data.AllowsPickups === 1) {
    detail.pickupAvailable = true;
    detail.pickupLocation = [data.Suburb, data.Region].filter(Boolean).join(', ') || null;
  } else if (data.AllowsPickups === 3) {
    detail.pickupAvailable = false;
    detail.pickupLocation = null;
  }
  // any other/unrecognized value: leave both keys unset, same as "absent" — we don't know

  const startDate = parseTradeMeDate(data.StartDate as string | undefined);
  if (startDate) detail.startDate = startDate;
  const endDate = parseTradeMeDate(data.EndDate as string | undefined);
  if (endDate) detail.endDate = endDate;

  if (data.CategoryPath) detail.categoryPath = data.CategoryPath as string;

  const rawPhotos = data.Photos as RawPhoto[] | undefined;
  if (rawPhotos?.length) {
    const photos: ListingPhoto[] = [];
    for (const photo of rawPhotos) {
      const { Thumbnail: thumbnailUrl, FullSize: fullSizeUrl } = photo.Value ?? {};
      if (thumbnailUrl && fullSizeUrl) photos.push({ thumbnailUrl, fullSizeUrl });
    }
    detail.photos = photos;
  }

  const rawMember = data.Member as RawMember | undefined;
  if (rawMember?.MemberId != null) {
    detail.seller = {
      memberId: rawMember.MemberId,
      nickname: rawMember.Nickname,
      feedbackCount: rawMember.FeedbackCount,
      isTopSeller: rawMember.IsTopSeller,
      dateJoined: parseTradeMeDate(rawMember.DateJoined),
    };
  }

  return detail;
}

// ── Playwright helpers ────────────────────────────────────────────────────────

// Exported so tests can assert the pagination loop's page.click() call actually
// uses these values, rather than a mock that ignores its arguments — a typo'd
// selector or dropped timeout would otherwise pass every test silently.
export const PAGER_NEXT_SELECTOR = 'a:has-text("Next")';
// Bounds how long a single click is allowed to hang looking for/acting on the
// pager before treating it as "no pager" and stopping pagination gracefully.
// Kept well under waitForSearchApiResponseAsync's own 12000ms so a genuinely
// missing pager fails fast rather than stacking two ~12s waits.
export const PAGER_CLICK_TIMEOUT_MS = 5000;
// Caps total wall-clock time spent walking pages 2+ (pages 1 and the initial
// listing count are not counted). Each page can cost up to PAGER_CLICK_TIMEOUT_MS
// (5000ms) plus waitForSearchApiResponseAsync's own 12000ms fallback — up to ~17s
// — and with MAX_PAGES_PER_SEARCH = 20 that's an unbounded-in-practice ~5.4
// minutes worst case for a single search on a slow-but-not-failing walk. This
// value is double the old goto()-based pagination's fixed ~30s worst case,
// giving a genuinely slow (but working) walk real headroom, while still turning
// an effectively unbounded hold on one of only 3 trademe.co.nz concurrency-limiter
// slots into a predictable ceiling.
export const PAGINATION_MAX_DURATION_MS = 60000;

// Returns both the eventual result and an explicit `cancel` handle so a caller
// that abandons the wait early (e.g. the pager click that triggered it threw)
// can unregister the listener and clear the timer immediately, rather than
// leaving both live for up to 12s — see the pagination loop in
// runQuickSearchAsync below, which is the only caller that needs `cancel`.
function waitForSearchApiResponseAsync(page: Page): {
  promise: Promise<{ listings: Listing[]; totalCount: number; pageSize: number }>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout>;
  let handler: (response: Response) => Promise<void>;
  const promise = new Promise<{ listings: Listing[]; totalCount: number; pageSize: number }>(
    (resolve) => {
      handler = async (response: Response) => {
        if (response.url().includes('api.trademe.co.nz/v1/search') && response.status() === 200) {
          page.off('response', handler);
          clearTimeout(timer);
          try {
            const data = (await response.json()) as Record<string, unknown>;
            resolve(parseSearchApiResponse(data));
          } catch {
            resolve({ listings: [], totalCount: 0, pageSize: 1 });
          }
        }
      };
      page.on('response', handler);
      timer = setTimeout(() => {
        page.off('response', handler);
        resolve({ listings: [], totalCount: 0, pageSize: 1 });
      }, 12000);
    }
  );
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
      page.off('response', handler);
    },
  };
}

// Self-contained "make one live TradeMe search request" helper: launches its own
// throwaway browser and closes it before returning, rather than sharing a session
// with a caller's own browser/context. Used by the discover root-search probe,
// which has no existing browser session to reuse.
export async function fetchSearchPage1Async(
  url: string
): Promise<{ listings: Listing[]; totalCount: number; pageSize: number }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-NZ' });
    const page = await context.newPage();
    const { promise: responsePromise } = waitForSearchApiResponseAsync(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return await responsePromise;
  } finally {
    await browser.close();
  }
}

const LISTING_DETAIL_API_PATTERN = /api\.trademe\.co\.nz\/v1\/listings\/.+\.json/;

function waitForListingDetailResponseAsync(page: Page): Promise<DeepSearchDetail | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const handler = async (response: Response) => {
      if (!LISTING_DETAIL_API_PATTERN.test(response.url())) return;
      page.off('response', handler);
      clearTimeout(timer);
      if (response.status() !== 200) {
        console.warn(
          `[trademe] detail fetch got status ${response.status()} for ${response.url()}`
        );
        resolve(null);
        return;
      }
      try {
        const data = (await response.json()) as Record<string, unknown>;
        resolve(parseListingDetailResponse(data));
      } catch (error) {
        console.error(`[trademe] failed to parse detail response for ${response.url()}`, error);
        resolve(null);
      }
    };
    page.on('response', handler);
    timer = setTimeout(() => {
      page.off('response', handler);
      console.warn(`[trademe] detail fetch timed out`);
      resolve(null);
    }, 12000);
  });
}

export async function fetchSingleListingDetailAsync(
  page: Page,
  url: string
): Promise<DeepSearchDetail> {
  const detailPromise = waitForListingDetailResponseAsync(page);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const detail = await detailPromise;
  if (detail === null) throw new Error(`failed to fetch listing detail for ${url}`);
  return detail;
}

// ── Discover URL building ─────────────────────────────────────────────────────

const TRADEME_SECTIONS = new Set(['motors', 'property', 'jobs', 'flatmates-wanted', 'services']);

export function buildTrademeUrl(
  entry: DiscoverEntry,
  maxPrice: number,
  fulfillment: Fulfillment,
  regionValue: string | undefined,
  condition: ListingCondition
): string {
  const topLevel = entry.slug.split('/')[0];
  const urlSlug = TRADEME_SECTIONS.has(topLevel) ? entry.slug : `marketplace/${entry.slug}`;
  const params = new URLSearchParams();
  if (entry.searchString) params.set('search_string', entry.searchString);
  if (maxPrice > 0) params.set('price_max', String(maxPrice));
  if (fulfillment === 'pickup' && regionValue) {
    params.set('user_region', regionValue);
    params.set('shipping_method', 'pickup');
  }
  params.set('condition', condition);
  const qs = params.toString();
  return `https://www.trademe.co.nz/a/${urlSlug}/search${qs ? `?${qs}` : ''}`;
}

// A categoryless sibling of buildTrademeUrl for the discover root-search probe —
// passing an empty slug through buildTrademeUrl would build a broken
// `.../a/marketplace//search`, so this builds the bare `/a/marketplace/search` path directly.
export function buildRootMarketplaceSearchUrl(
  searchString: string,
  maxPrice: number,
  fulfillment: Fulfillment,
  regionValue: string | undefined,
  condition: ListingCondition | null
): string {
  const params = new URLSearchParams();
  if (searchString) params.set('search_string', searchString);
  if (maxPrice > 0) params.set('price_max', String(maxPrice));
  if (fulfillment === 'pickup' && regionValue) {
    params.set('user_region', regionValue);
    params.set('shipping_method', 'pickup');
  }
  if (condition) params.set('condition', condition);
  const qs = params.toString();
  return `https://www.trademe.co.nz/a/marketplace/search${qs ? `?${qs}` : ''}`;
}

// Fires a categoryless root-marketplace search on the raw prompt before falling back
// to AI category selection. A small, non-zero TotalCount on that root search is itself
// a strong "no narrowing needed" signal — the widest possible net already found the
// right, small set of results — so it's used directly and the AI call is skipped
// entirely. Zero results is treated as "the probe likely didn't match well" (not
// "nothing exists") and falls through to AI category selection like a too-large count.
// A probe failure (timeout/network error) also falls through silently, with a warning,
// rather than failing the whole discover call.
// `result` is non-null only when the probe won (narrow enough to use directly).
// `warnings` carries a probe-failure message through to the caller even on a miss.
//
// When `includeNewItems` is set, the eventual result includes both a used- and a
// new-condition URL, so the narrowness check itself must cover both conditions —
// checking the used count alone could pass "narrow enough" while new-condition
// listings (never counted) are actually abundant (PR #41 review, QA finding #1).
// Rather than doubling the probe's live-request cost with a second condition-scoped
// query, a single condition-less query returns the combined new+used count in one
// request, checked against a correspondingly higher threshold.
async function tryRootSearchProbeAsync(
  trimmedPrompt: string,
  context: DiscoverContext
): Promise<{ result: RecipeDiscoverResult | null; warnings: string[] }> {
  const usedRootUrl = buildRootMarketplaceSearchUrl(
    trimmedPrompt,
    context.maxPrice,
    context.fulfillment,
    context.regionValue,
    'used'
  );
  const newRootUrl = context.includeNewItems
    ? buildRootMarketplaceSearchUrl(
        trimmedPrompt,
        context.maxPrice,
        context.fulfillment,
        context.regionValue,
        'new'
      )
    : null;

  const probeUrl = context.includeNewItems
    ? buildRootMarketplaceSearchUrl(
        trimmedPrompt,
        context.maxPrice,
        context.fulfillment,
        context.regionValue,
        null
      )
    : usedRootUrl;
  const threshold = context.includeNewItems
    ? ROOT_SEARCH_COMBINED_RESULT_THRESHOLD
    : ROOT_SEARCH_RESULT_THRESHOLD;

  let totalCount: number;
  try {
    totalCount = (await enqueue(probeUrl, () => fetchSearchPage1Async(probeUrl))).totalCount;
  } catch (error) {
    return { result: null, warnings: [`root search probe failed: ${(error as Error).message}`] };
  }

  if (totalCount === 0 || totalCount > threshold) return { result: null, warnings: [] };

  const urls = [usedRootUrl];
  const warnings: string[] = [];

  if (newRootUrl) urls.push(newRootUrl);

  // TradeMe's legacy SearchResults.aspx accepts cid=0&rptpath=all as an "all
  // categories" sentinel, so the root (categoryless) case can still get a
  // sold-items URL without needing a resolved category's legacy_path.
  if (context.includeSoldItems) {
    urls.push(buildRootLegacySearchUrl(trimmedPrompt));
  }

  return { result: { urls, warnings }, warnings: [] };
}

async function buildDiscoverUrlsAsync(
  prompt: string,
  context: DiscoverContext
): Promise<RecipeDiscoverResult> {
  const trimmedPrompt = prompt.trim();

  // Kick off the root-search probe and AI category resolution together rather than
  // strictly sequentially. Neither needs the other's output to run (AI resolution's
  // result is simply discarded when the probe hits), so awaiting the probe first was
  // pure additive latency on the common case — a broad prompt where the probe misses
  // (PR #41 review, Backend finding #3 / "Future Ticket" #2).
  const probePromise = tryRootSearchProbeAsync(trimmedPrompt, context);
  const categoriesPromise = resolveDiscoverCategoriesAsync(prompt, context.getAiConfig);
  // If the probe hits, categoriesPromise's outcome (including a rejection) is
  // discarded below without ever being awaited on that path — attach a no-op handler
  // now so that discarded rejection can't surface as an unhandled promise rejection.
  // `categoriesPromise` is still awaited directly further down when the probe misses,
  // and throws there as normal.
  categoriesPromise.catch(() => {});

  const probe = await probePromise;
  if (probe.result !== null) return probe.result;

  const { entries, warnings } = await categoriesPromise;
  const urls = entries.map((entry) =>
    buildTrademeUrl(entry, context.maxPrice, context.fulfillment, context.regionValue, 'used')
  );
  const allWarnings = [...probe.warnings, ...warnings];

  if (context.includeNewItems) {
    for (const entry of entries) {
      urls.push(
        buildTrademeUrl(entry, context.maxPrice, context.fulfillment, context.regionValue, 'new')
      );
    }
  }

  if (context.includeSoldItems) {
    const stmt = stmtGetCategoryLegacyPath(getDb());
    for (const entry of entries) {
      const row = stmt.get(entry.slug);
      if (!row) {
        allWarnings.push(`no legacy category mapping for slug "${entry.slug}"`);
        continue;
      }
      urls.push(buildLegacySearchUrl(entry, row.legacy_path));
    }
  }

  return { urls, warnings: allWarnings };
}

// ── Recipe implementation ─────────────────────────────────────────────────────

async function quickSearchAsync(
  searchUrl: string,
  onEvent: (event: QuickSearchEvent) => void,
  isCancelled?: () => boolean
): Promise<void> {
  onEvent({ type: 'criteria', filters: extractImplicitFilters(searchUrl) });

  // A discover request can fan out several concurrent TradeMe search URLs per
  // category (used/new/sold), and this PR adds another multiplier on top of
  // that. Route the launch through the per-domain concurrency limiter so
  // concurrent searches can't stack unbounded headless browsers. This is now
  // the *only* enqueue() call for the whole search — pagination (below) walks
  // pages 2+ by clicking within the same already-open tab/slot, not by taking
  // further limiter slots of its own. The criteria event is emitted before
  // queueing so the card gets its filter chips immediately, even while the
  // search waits for a slot.
  await enqueue(searchUrl, () => runQuickSearchAsync(searchUrl, onEvent, isCancelled));
}

async function runQuickSearchAsync(
  searchUrl: string,
  onEvent: (event: QuickSearchEvent) => void,
  isCancelled?: () => boolean
): Promise<void> {
  let context: BrowserContext | undefined;
  try {
    const browser = await getSharedBrowserAsync('trademe');
    const activeContext = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-NZ' });
    context = activeContext;
    const page = await activeContext.newPage();

    onEvent({ type: 'progress', phase: 'paging', page: 1 });
    const { promise: p1Promise } = waitForSearchApiResponseAsync(page);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const { listings: p1Listings, totalCount, pageSize } = await p1Promise;

    const totalPages = Math.min(
      Math.ceil(totalCount / pageSize),
      MAX_PAGES_PER_SEARCH,
      Math.ceil(MAX_RESULTS_PER_URL / pageSize)
    );

    onEvent({ type: 'progress', phase: 'counted', totalResults: totalCount, totalPages });

    const seenUrls = new Set<string>();
    let emittedCount = 0;
    const emit = (listings: Listing[]) => {
      for (const listing of listings) {
        if (emittedCount >= MAX_RESULTS_PER_URL) return;
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        emittedCount++;
        onEvent({ type: 'listing', data: listing });
      }
    };

    emit(p1Listings);

    // Pages 2+: click the in-page "Next" pager sequentially on the same tab,
    // instead of opening new tabs and goto()-ing a &page=N URL. A fresh goto()
    // to that URL never fires the /v1/search XHR TradeMe's SPA depends on
    // (live-verified against production: 0/24 fetches via goto for pages 2+
    // fired it, vs. 24/24 real in-page clicks); only a genuine click does. One
    // tab also means only the outer enqueue() call in quickSearchAsync ever
    // holds a domain-limiter slot for the whole walk, rather than nesting
    // further enqueue calls inside it.
    const paginationDeadline = Date.now() + PAGINATION_MAX_DURATION_MS;

    for (let pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
      if (isCancelled?.()) break;
      if (emittedCount >= MAX_RESULTS_PER_URL) break;
      if (Date.now() >= paginationDeadline) {
        console.warn(
          `[trademe] pagination deadline (${PAGINATION_MAX_DURATION_MS}ms) hit at page ${pageNumber} of ${totalPages} for ${searchUrl}`
        );
        break;
      }

      onEvent({ type: 'progress', phase: 'paging', page: pageNumber, totalPages });

      let listings: Listing[];
      const { promise: responsePromise, cancel } = waitForSearchApiResponseAsync(page);
      try {
        await page.click(PAGER_NEXT_SELECTOR, { timeout: PAGER_CLICK_TIMEOUT_MS });
        ({ listings } = await responsePromise);
      } catch (error) {
        // Pager missing/not clickable within PAGER_CLICK_TIMEOUT_MS. A partial
        // result is a good result: stop here and still report success below.
        // Logged because the loop only reaches this branch when another page
        // was still expected (pageNumber <= totalPages) — a genuine last page
        // never gets here, so this is always worth distinguishing from a
        // broken pager selector.
        //
        // cancel() unregisters the response listener and clears the internal
        // 12s timeout immediately — without it, both would stay live until
        // the timeout fired on its own, by which point the outer `finally`
        // has very likely already closed the browser they reference.
        cancel();
        console.warn(
          `[trademe] pager click failed on page ${pageNumber} of ${totalPages} for ${searchUrl}`,
          error
        );
        break;
      }

      // Click landed but never triggered a matching /v1/search response before
      // waitForSearchApiResponseAsync's own 12s timeout fell back to empty —
      // same graceful stop as a missing pager, and logged for the same reason.
      if (listings.length === 0) {
        console.warn(
          `[trademe] pager click on page ${pageNumber} of ${totalPages} landed but no search response arrived for ${searchUrl}`
        );
        break;
      }

      emit(listings);
    }

    onEvent({ type: 'complete' });
  } catch (error) {
    onEvent({ type: 'error', message: (error as Error).message });
  } finally {
    await context?.close();
  }
}

async function deepSearchAsync(
  listings: Listing[],
  onEvent: (event: DeepSearchEvent) => void,
  isCancelled?: () => boolean
): Promise<void> {
  let context: BrowserContext | undefined;
  try {
    const browser = await getSharedBrowserAsync('trademe');
    const activeContext = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-NZ' });
    context = activeContext;

    await Promise.all(
      listings.map((listing, listingIndex) =>
        enqueue(listing.url, async () => {
          const currentPage = await activeContext.newPage();
          if (isCancelled?.()) {
            await currentPage.close();
            return;
          }
          try {
            onEvent({
              type: 'progress',
              index: listingIndex + 1,
              total: listings.length,
              title: listing.title,
            });
            try {
              const detail = await fetchSingleListingDetailAsync(currentPage, listing.url);
              onEvent({ type: 'detail', url: listing.url, detail });
            } catch (error) {
              onEvent({
                type: 'detail-error',
                url: listing.url,
                message: (error as Error).message,
              });
            }
          } finally {
            await currentPage.close();
          }
        })
      )
    );
    onEvent({ type: 'complete' });
  } catch (error) {
    onEvent({ type: 'error', message: (error as Error).message });
  } finally {
    await context?.close();
  }
}

// Excludes price: TradeMe listings can be live auctions where price is the
// current bid, changing without the listing being new. thumbnailUrl is used
// instead — TradeMe's CDN serves a bare, stable path per photo (no signed
// query params), confirmed by buildListing above.
function computeAlertFingerprint(listing: Listing): string {
  return hashFingerprintParts([
    listing.title,
    listing.location,
    listing.description,
    listing.thumbnailUrl,
  ]);
}

export const trademeRecipe: DiscoverableRecipe = {
  name: TRADEME_PATTERN.name,
  matches(url: string): boolean {
    try {
      return new URL(url).hostname.endsWith(TRADEME_PATTERN.hostname);
    } catch {
      return false;
    }
  },
  extractImplicitFilters,
  quickSearchAsync,
  deepSearchAsync,
  buildDiscoverUrlsAsync,
  computeAlertFingerprint,
};
