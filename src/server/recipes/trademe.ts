import { chromium, type Page, type Response } from "playwright";
import { enqueue } from "../../lib/queue";
import type {
  DeepSearchDetail,
  DeepSearchEvent,
  DiscoverableRecipe,
  DiscoverContext,
  Fulfillment,
  Listing,
  ListingPhoto,
  QuickSearchEvent,
  RecipeDiscoverResult,
  ReserveStatus,
} from "../../lib/recipes/base";
import { requirePattern } from "../../lib/recipes/metadata";
import { aiJSON } from "../ai";
import { MAX_PAGES_PER_SEARCH } from "../constants";
import type { CategoryRow } from "../db";
import { getDb, stmtGetCategoriesAtDepth2, stmtGetCategoriesByTop2 } from "../db";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TRADEME_BASE = "https://www.trademe.co.nz/a";

const TRADEME_PATTERN = requirePattern("trademe");

type ApiItem = Record<string, unknown>;

// ── Implicit filter extraction ────────────────────────────────────────────────

const DISPLAY_NAME_BY_PARAM_NAME: Record<string, string> = {
  search_string: "Search",
  condition: "Condition",
  sort_order: "Sort",
};

const LABEL_BY_PANEL_HASH: Record<string, string> = {
  "5c34c1efa0ac468f91e15161d549c479": "RAM",
  "7a2bb94c0cb44806ac995a4fc854bcbc": "Screen Size",
};

const IGNORED_PARAM_NAMES = new Set([
  "rows",
  "page",
  "return_canonical",
  "return_metadata",
  "return_ads",
  "return_empty_categories",
  "return_super_features",
  "return_did_you_mean",
  "return_variants",
  "snap_parameters",
  "preferred_shipping_location",
  "return_parameter_counts",
]);

export function extractImplicitFilters(urlStr: string): Array<[string, string]> {
  try {
    const url = new URL(urlStr);
    const filterRows: Array<[string, string]> = [];

    const pathMatch = url.pathname.match(/\/a\/(.+?)\/search/);
    if (pathMatch) {
      // Only the last two breadcrumb sections — deep paths are noise on screen.
      const cat = pathMatch[1]
        .split("/")
        .slice(-2)
        .map((pathSegment) =>
          pathSegment
            .split("-")
            .map((word) => word[0].toUpperCase() + word.slice(1))
            .join(" "),
        )
        .join(" › ");
      filterRows.push(["Category", cat]);
    }

    const grouped: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams.entries()) {
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(v);
    }

    for (const [key, vals] of Object.entries(grouped)) {
      if (IGNORED_PARAM_NAMES.has(key)) continue;

      if (key in DISPLAY_NAME_BY_PARAM_NAME) {
        let filterValue = vals.join(", ");
        if (key === "condition") filterValue = filterValue[0].toUpperCase() + filterValue.slice(1);
        filterRows.push([DISPLAY_NAME_BY_PARAM_NAME[key], filterValue]);
        continue;
      }

      if (key === "price_min" || key === "price_max") {
        const label = key === "price_min" ? "Price Min" : "Price Max";
        filterRows.push([label, `$${vals.join(", $")}`]);
        continue;
      }

      if (key.startsWith("RefinePanel")) {
        const hash = key.replace("RefinePanel", "");
        let label = LABEL_BY_PANEL_HASH[hash];
        if (!label) {
          if (vals.some((paramValue) => paramValue.toLowerCase().includes("gb"))) label = "RAM";
          else if (vals.some((paramValue) => paramValue.includes('"'))) label = "Screen Size";
          else label = "Filter";
        }
        filterRows.push([label, vals.join(", ")]);
        continue;
      }

      const label = key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
      filterRows.push([label, vals.join(", ")]);
    }

    return filterRows;
  } catch {
    return [];
  }
}

// ── Price helpers ──────────────────────────────────────────────────────────────

function parsePriceValue(display: string): number | null {
  const match = String(display)
    .replace(/,/g, "")
    .match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

// ── Field mapping helpers ──────────────────────────────────────────────────────

// Empirically verified against real listings: absent → no reserve; 1 → met;
// 2 → not met; 3 is not really a reserve state at all — it's always paired with
// IsBuyNowOnly, i.e. the listing isn't an auction, so the frontend never renders it.
export function mapReserveState(reserveState: number | undefined): ReserveStatus {
  if (reserveState === undefined) return "NONE";
  if (reserveState === 1) return "MET";
  if (reserveState === 2) return "NOT_MET";
  return "UNKNOWN";
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
    fullSizeUrl: url.replace("/photoserver/thumb/", "/photoserver/full/"),
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
  const url = raw.canonicalPath ? `${TRADEME_BASE}${raw.canonicalPath}` : "";
  if (!raw.title || !url) return null;

  const listing: Listing = {
    source: TRADEME_PATTERN.name,
    title: raw.title,
    price: parsePriceValue(raw.priceDisplay),
    location: [raw.suburb, raw.region].filter(Boolean).join(", ") || "Unknown",
    url,
    thumbnailUrl: raw.pictureHref?.replace("/photoserver/thumb/", "/photoserver/full/"),
    isAuction: !raw.isBuyNowOnly,
    reserveStatus: mapReserveState(raw.reserveState),
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
        title: (item.Title as string) ?? "",
        priceDisplay: (item.PriceDisplay as string) ?? "",
        suburb: item.Suburb as string | undefined,
        region: item.Region as string | undefined,
        canonicalPath: (item.CanonicalPath as string) ?? "",
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
      }),
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
    extraAttributes[attribute.Name] = attribute.DisplayValue ?? attribute.Value ?? "";
  }
  return extraAttributes;
}

function extractQuestionsAndAnswersFromApi(
  rawQuestions: RawQuestion[] | undefined,
): NonNullable<DeepSearchDetail["questionsAndAnswers"]> {
  return (rawQuestions ?? []).map((question) => ({
    question: question.Comment ?? "",
    answer: question.Answer ?? "",
    askedBy: question.AskingMember?.Nickname,
    askedAt: parseTradeMeDate(question.CommentDate),
    answeredAt: question.Answer ? parseTradeMeDate(question.AnswerDate) : undefined,
  }));
}

export function parseListingDetailResponse(data: Record<string, unknown>): DeepSearchDetail {
  const shippingOptions = (data.ShippingOptions ?? []) as RawShippingOption[];
  const hasBuyNow = Boolean(data.HasBuyNow);

  // TODO(pickup-mapping): AllowsPickups mapping is deferred — resolve empirically
  // before adding pickupAvailable/pickupLocation to this result.
  const detail: DeepSearchDetail = {
    description: String(data.Body ?? ""),
    extraAttributes: extractExtraAttributes(data.Attributes as RawAttribute[] | undefined),
    questionsAndAnswers: extractQuestionsAndAnswersFromApi(
      (data.Questions as { List?: RawQuestion[] } | undefined)?.List,
    ),
    buyNowPrice: hasBuyNow ? Number(data.BuyNowPrice) : null,
    reserveStatus: mapReserveState(data.ReserveState as number | undefined),
    shippingAvailable: shippingOptions.length > 0,
    shippingCost:
      shippingOptions.length > 0
        ? Math.min(...shippingOptions.map((option) => option.Price ?? Infinity))
        : null,
  };

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

function waitForSearchApiResponseAsync(
  page: Page,
): Promise<{ listings: Listing[]; totalCount: number; pageSize: number }> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const handler = async (response: Response) => {
      if (response.url().includes("api.trademe.co.nz/v1/search") && response.status() === 200) {
        page.off("response", handler);
        clearTimeout(timer);
        try {
          const data = (await response.json()) as Record<string, unknown>;
          resolve(parseSearchApiResponse(data));
        } catch {
          resolve({ listings: [], totalCount: 0, pageSize: 1 });
        }
      }
    };
    page.on("response", handler);
    timer = setTimeout(() => {
      page.off("response", handler);
      resolve({ listings: [], totalCount: 0, pageSize: 1 });
    }, 12000);
  });
}

const LISTING_DETAIL_API_PATTERN = /api\.trademe\.co\.nz\/v1\/listings\/.+\.json/;

function waitForListingDetailResponseAsync(page: Page): Promise<DeepSearchDetail | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const handler = async (response: Response) => {
      if (LISTING_DETAIL_API_PATTERN.test(response.url()) && response.status() === 200) {
        page.off("response", handler);
        clearTimeout(timer);
        try {
          const data = (await response.json()) as Record<string, unknown>;
          resolve(parseListingDetailResponse(data));
        } catch {
          resolve(null);
        }
      }
    };
    page.on("response", handler);
    timer = setTimeout(() => {
      page.off("response", handler);
      resolve(null);
    }, 12000);
  });
}

export async function fetchSingleListingDetailAsync(
  page: Page,
  url: string,
): Promise<DeepSearchDetail> {
  const detailPromise = waitForListingDetailResponseAsync(page);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return (await detailPromise) ?? {};
}

// ── Discover URL building ─────────────────────────────────────────────────────

const TRADEME_SECTIONS = new Set(["motors", "property", "jobs", "flatmates-wanted", "services"]);

export type DiscoverEntry = { slug: string; searchString: string | null };

export const STEP1_SYSTEM_PROMPT =
  'You are a TradeMe NZ shopping assistant. From the category list below, pick the 1–3 categories where this item would most likely be listed for sale. Also suggest a short label for the search and a search query. Return JSON: { "categories": string[], "searchLabel": string, "searchQuery": string | null } using the exact category names from the list. For searchLabel: a short human-readable label for the search (e.g. "MacBook Pro laptops"). For searchQuery: use the product name only — no chip names, RAM, year, storage size, or any other specs. If the category already names the item type, use null. Examples: category=bookshelves → null; category=apple-laptops, user wants \'Apple MacBook Pro M1 16gb 2021\' → searchQuery=\'macbook pro\'.';

export const STEP2_SYSTEM_PROMPT =
  "You are a TradeMe NZ shopping assistant. From the categories below pick all subcategories where this item plausibly appears — err on the side of more coverage. Use a deep specific category when the user wants a particular brand/model, or a broader one when they want any item of that type. Never pick both a category and one of its subcategories — always choose the single most appropriate depth. Return JSON: { \"categories\": [{ \"slug\": string, \"searchString\": string | null }] }. Each slug must be a value shown in parentheses. For searchString: rule: use the product name only — no chip names, RAM, year, storage size, or any other specs. If the category already names the item type, use null. Examples: category=bookshelves → null; category=bedroom-furniture/other, item=bookshelf → searchString='bookshelf'; category=apple-laptops, user wants 'Apple MacBook Pro M1 16gb 2021' → searchString='macbook pro'.";

export function buildTrademeUrl(
  entry: DiscoverEntry,
  maxPrice: number,
  fulfillment: Fulfillment,
  regionValue: string | undefined,
): string {
  const topLevel = entry.slug.split("/")[0];
  const urlSlug = TRADEME_SECTIONS.has(topLevel) ? entry.slug : `marketplace/${entry.slug}`;
  const params = new URLSearchParams();
  if (entry.searchString) params.set("search_string", entry.searchString);
  if (maxPrice > 0) params.set("price_max", String(maxPrice));
  if (fulfillment === "pickup" && regionValue) {
    params.set("user_region", regionValue);
    params.set("shipping_method", "pickup");
  }
  const qs = params.toString();
  return `https://www.trademe.co.nz/a/${urlSlug}/search${qs ? `?${qs}` : ""}`;
}

export function collapseEntries(allEntries: DiscoverEntry[]): DiscoverEntry[] {
  const allSlugs = new Set(allEntries.map((e) => e.slug));
  const collapsed: DiscoverEntry[] = [];
  const consumed = new Set<string>();

  for (const entry of allEntries) {
    if (consumed.has(entry.slug)) continue;
    const parentSlug = entry.slug.split("/").slice(0, -1).join("/");
    if (allSlugs.has(parentSlug)) continue;
    const siblings = allEntries.filter(
      (e) =>
        e !== entry &&
        e.slug.split("/").slice(0, -1).join("/") === parentSlug &&
        e.searchString === entry.searchString,
    );
    // Collapse siblings only when the shared parent is at least 3 segments deep
    // (e.g. marketplace/computers/laptops) to avoid collapsing into a bare top-level slug.
    const MIN_COLLAPSIBLE_PARENT_DEPTH = 3;
    if (
      siblings.length >= 1 &&
      parentSlug &&
      parentSlug.split("/").length >= MIN_COLLAPSIBLE_PARENT_DEPTH
    ) {
      for (const sibling of siblings) consumed.add(sibling.slug);
      consumed.add(entry.slug);
      collapsed.push({ slug: parentSlug, searchString: entry.searchString });
    } else {
      collapsed.push(entry);
    }
  }
  return collapsed;
}

type Step2Category = { slug: string; searchString?: string | null };

async function buildDiscoverUrlsAsync(
  prompt: string,
  context: DiscoverContext,
): Promise<RecipeDiscoverResult> {
  const aiConfig = context.aiConfig;
  const database = getDb();
  const broad = stmtGetCategoriesAtDepth2(database).all();
  const broadDisplayList = broad.map((category) => category.display).join("\n");

  // 512 output tokens: step-1 returns a tiny JSON object (3 string fields) — input size (~3 k tokens for 392 categories) is unlimited by this parameter.
  const broadCategoryPick = (await aiJSON(
    aiConfig,
    "step1",
    STEP1_SYSTEM_PROMPT,
    `I'm looking for: ${prompt.trim()}\n\nAvailable categories:\n${broadDisplayList}`,
    512,
  )) as Record<string, unknown> | null;
  if (typeof broadCategoryPick !== "object" || broadCategoryPick === null)
    throw new Error("discover step1: expected object response");
  const rawCategories = (
    Array.isArray(broadCategoryPick.categories) ? broadCategoryPick.categories : []
  ) as string[];
  const selectedBroadSlugs: string[] = rawCategories
    .map((display: string) => broad.find((category) => category.display === display)?.slug)
    .filter((slug): slug is string => !!slug);
  if (selectedBroadSlugs.length === 0) throw new Error("AI returned no valid broad categories");
  const step1Warnings: string[] = [];
  if (selectedBroadSlugs.length < rawCategories.length) {
    const unrecognised = rawCategories.filter(
      (display: string) => !broad.some((category) => category.display === display),
    );
    step1Warnings.push(`step1: unrecognised categories ignored: ${unrecognised.join(", ")}`);
  }

  // Sequential (not parallel) so concurrent bursts don't collide on the provider's TPM limit.
  const subcategoryPickResults: Array<{
    top2Slug: string;
    candidates: CategoryRow[];
    result: Record<string, unknown> | null;
  }> = [];
  for (const top2Slug of selectedBroadSlugs) {
    const broadEntry = broad.find((category) => category.slug === top2Slug);
    if (!broadEntry) throw new Error(`invariant: slug ${top2Slug} not found in broad categories`);
    const candidates = stmtGetCategoriesByTop2(database).all(top2Slug);
    const specificList = candidates
      .map((category) => `${category.display} (slug: ${category.slug})`)
      .join("\n");
    // 1024 output tokens: step-2 returns a JSON array of slug+searchString pairs; a broad category can have dozens of subcategories, so 1024 gives headroom over step-1's 512.
    const result = await aiJSON(
      aiConfig,
      `step2:${top2Slug}`,
      STEP2_SYSTEM_PROMPT,
      `I'm looking for: ${prompt.trim()}\n\nCategories within "${broadEntry.display}":\n${specificList}`,
      1024,
    );
    subcategoryPickResults.push({
      top2Slug,
      candidates,
      result: result as Record<string, unknown> | null,
    });
  }

  const allEntries: DiscoverEntry[] = [];
  const warnings: string[] = [];
  for (const { top2Slug, candidates, result } of subcategoryPickResults) {
    const validSlugs = new Set(candidates.map((category) => category.slug));
    if (result === null || !Array.isArray(result.categories)) {
      warnings.push(`step2:${top2Slug} unexpected result`);
      continue;
    }
    for (const category of (result.categories as Step2Category[]).filter((category) =>
      validSlugs.has(category.slug),
    )) {
      allEntries.push({ slug: category.slug, searchString: category.searchString ?? null });
    }
  }

  const collapsedEntries = collapseEntries(allEntries);
  const urls = collapsedEntries.map((entry) =>
    buildTrademeUrl(entry, context.maxPrice, context.fulfillment, context.regionValue),
  );
  if (urls.length === 0) throw new Error("AI returned no valid specific categories");
  return { urls, warnings: [...step1Warnings, ...warnings] };
}

// ── Recipe implementation ─────────────────────────────────────────────────────

async function quickSearchAsync(
  searchUrl: string,
  onEvent: (event: QuickSearchEvent) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  onEvent({ type: "criteria", filters: extractImplicitFilters(searchUrl) });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: "en-NZ" });
    const page = await context.newPage();

    onEvent({ type: "progress", phase: "paging", page: 1 });
    const p1Promise = waitForSearchApiResponseAsync(page);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    const { listings: p1Listings, totalCount, pageSize } = await p1Promise;

    const totalPages = Math.min(Math.ceil(totalCount / pageSize), MAX_PAGES_PER_SEARCH);

    onEvent({ type: "progress", phase: "counted", totalResults: totalCount, totalPages });

    const seenUrls = new Set<string>();
    const emit = (listings: Listing[]) => {
      for (const listing of listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        onEvent({ type: "listing", data: listing });
      }
    };

    emit(p1Listings);

    const pageNums = Array.from({ length: totalPages - 1 }, (_, pageIndex) => pageIndex + 2);
    const extraPages = await Promise.all(pageNums.map(() => context.newPage()));

    await Promise.all(
      pageNums.map((pageNumber, pageIndex) => {
        const pageUrlInstance = new URL(searchUrl);
        pageUrlInstance.searchParams.set("page", String(pageNumber));
        const pageUrl = pageUrlInstance.toString();
        return enqueue(pageUrl, async () => {
          const currentPage = extraPages[pageIndex];
          if (isCancelled?.()) {
            await currentPage.close();
            return;
          }
          try {
            onEvent({ type: "progress", phase: "paging", page: pageNumber, totalPages });
            const promise = waitForSearchApiResponseAsync(currentPage);
            await currentPage.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

            const { listings } = await promise;
            emit(listings);
          } finally {
            await currentPage.close();
          }
        });
      }),
    );

    onEvent({ type: "complete" });
  } catch (error) {
    onEvent({ type: "error", message: (error as Error).message });
  } finally {
    await browser.close();
  }
}

async function deepSearchAsync(
  listings: Listing[],
  onEvent: (event: DeepSearchEvent) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: "en-NZ" });

    await Promise.all(
      listings.map((listing, listingIndex) =>
        enqueue(listing.url, async () => {
          const currentPage = await context.newPage();
          if (isCancelled?.()) {
            await currentPage.close();
            return;
          }
          try {
            onEvent({
              type: "progress",
              index: listingIndex + 1,
              total: listings.length,
              title: listing.title,
            });
            const detail = await fetchSingleListingDetailAsync(currentPage, listing.url);
            onEvent({ type: "detail", url: listing.url, detail });
          } finally {
            await currentPage.close();
          }
        }),
      ),
    );
    onEvent({ type: "complete" });
  } catch (error) {
    onEvent({ type: "error", message: (error as Error).message });
  } finally {
    await browser.close();
  }
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
};
