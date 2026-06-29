import { chromium, type Page, type Response } from "playwright";
import { aiJSON, getAIConfig } from "../../server/ai";
import { MAX_PAGES_PER_SEARCH } from "../../server/constants";
import { getDb, stmtGetCategoriesAtDepth2, stmtGetCategoriesByTop2 } from "../../server/db";
import { enqueue } from "../queue";
import type {
  DiscoverContext,
  DeepSearchEvent,
  Fulfillment,
  Listing,
  ListingDetail,
  QuickSearchEvent,
  Recipe,
} from "./base";
import { requirePattern } from "./metadata";

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
      const cat = pathMatch[1]
        .split("/")
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
        if (key === "search_string") filterValue = `"${filterValue}"`;
        filterRows.push([DISPLAY_NAME_BY_PARAM_NAME[key], filterValue]);
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

// ── Price + fulfillment helpers ───────────────────────────────────────────────

function parsePriceValue(display: string): number | null {
  const match = String(display)
    .replace(/,/g, "")
    .match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

export function mapFulfillment(
  raw: number | undefined,
): { pickupAvailable: boolean; shippingAvailable: boolean } | undefined {
  switch (raw) {
    case 1:
      return { pickupAvailable: true, shippingAvailable: true }; // ships NZ
    case 2:
      return { pickupAvailable: true, shippingAvailable: false }; // pickup only
    case 3:
      return { pickupAvailable: true, shippingAvailable: true }; // ships NZ (paid)
    case 0:
    case undefined:
      return undefined;
    default:
      console.warn(`[trademe] unknown allowsPickups value: ${raw}`);
      return undefined;
  }
}

// ── API response parsing ──────────────────────────────────────────────────────

export type RawApiItem = {
  title: string;
  priceDisplay: string;
  suburb?: string;
  region?: string;
  canonicalPath: string;
  pictureHref?: string;
  allowsPickups?: number;
};

export function buildListing(raw: RawApiItem): Listing | null {
  const display = raw.priceDisplay || "Price on request";
  const url = raw.canonicalPath ? `${TRADEME_BASE}${raw.canonicalPath}` : "";
  if (!raw.title || !url) return null;
  return {
    source: TRADEME_PATTERN.name,
    title: raw.title,
    price: parsePriceValue(display),
    priceDisplay: display,
    location: [raw.suburb, raw.region].filter(Boolean).join(", ") || "Unknown",
    url,
    thumbnailUrl: raw.pictureHref?.replace("/photoserver/thumb/", "/photoserver/full/"),
    fulfillment: mapFulfillment(raw.allowsPickups),
    isAuction: true,
  };
}

export function parseFrendState(
  state: Record<string, unknown>,
): { listings: Listing[]; totalCount: number; pageSize: number } | null {
  for (const value of Object.values(state)) {
    const bundleData = (value as Record<string, unknown>)?.b as Record<string, unknown> | undefined;
    if (!bundleData || !Array.isArray(bundleData.list)) continue;
    const items = bundleData.list as ApiItem[];
    const totalCount = (bundleData.totalCount as number) ?? 0;
    const pageSize = (bundleData.pageSize as number) || items.length || 1;
    const listings = items
      .map(
        (item): RawApiItem => ({
          title: (item.title as string) ?? "",
          priceDisplay: (item.priceDisplay as string) ?? "",
          suburb: item.suburb as string | undefined,
          region: item.region as string | undefined,
          canonicalPath: (item.canonicalPath as string) ?? "",
          pictureHref: (item.pictureHref as string) || undefined,
          allowsPickups: item.allowsPickups as number | undefined,
        }),
      )
      .map(buildListing)
      .filter((listing): listing is Listing => listing !== null);
    if (listings.length > 0) return { listings, totalCount, pageSize };
  }
  return null;
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
        allowsPickups: item.AllowsPickups as number | undefined,
      }),
    )
    .map(buildListing)
    .filter((listing): listing is Listing => listing !== null);
  return { listings, totalCount, pageSize };
}

// ── Detail extraction ─────────────────────────────────────────────────────────

export function extractQuestionsAndAnswers(
  bodyText: string,
): Array<{ question: string; answer: string }> {
  const start = bodyText.toLowerCase().indexOf("questions & answers");
  if (start === -1) return [];
  const lineEnd = bodyText.indexOf("\n", start);
  if (lineEnd === -1) return [];
  let after = bodyText.slice(lineEnd + 1).trimStart();
  if (after.startsWith("Ask a question\n"))
    after = after.slice("Ask a question\n".length).trimStart();
  const afterLower = after.toLowerCase();
  const sectionEndMarkers = [
    "ask a question",
    "about the seller",
    "about the store",
    "seller's other listings",
    "similar listings",
    "you might also like",
    "back to top",
  ];
  let end = after.length;
  for (const sectionEndMarker of sectionEndMarkers) {
    const idx = afterLower.indexOf(sectionEndMarker);
    if (idx !== -1 && idx < end) end = idx;
  }
  const content = after.slice(0, end).trim();
  if (!content) return [];

  const lines = content.split("\n");
  const segments: string[] = [];
  const current: string[] = [];
  let lineIndex = 0;
  let foundAnyUsernames = false;
  while (lineIndex < lines.length) {
    if (
      lineIndex + 1 < lines.length &&
      /\(\d+$/.test(lines[lineIndex].trim()) &&
      lines[lineIndex + 1].trim().startsWith(") •")
    ) {
      foundAnyUsernames = true;
      segments.push(current.splice(0).join("\n").trim());
      lineIndex += 2;
    } else {
      current.push(lines[lineIndex]);
      lineIndex++;
    }
  }
  if (current.length) segments.push(current.join("\n").trim());

  if (!foundAnyUsernames) return [];

  const pairs: Array<{ question: string; answer: string }> = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 2) {
    const question = segments[segmentIndex].trim();
    const answer = segments[segmentIndex + 1]?.trim() ?? "";
    if (question) pairs.push({ question, answer });
  }
  return pairs;
}

export function extractDetails(bodyText: string): Array<{ key: string; value: string }> {
  const detailsStart = bodyText.indexOf("Details\n");
  if (detailsStart === -1) return [];
  const after = bodyText.slice(detailsStart + "Details\n".length);
  const sectionEndMarkers = ["Description\n", "Shipping & pick-up options"];
  let end = after.length;
  for (const sectionEndMarker of sectionEndMarkers) {
    const idx = after.indexOf(sectionEndMarker);
    if (idx !== -1 && idx < end) end = idx;
  }
  const lines = after
    .slice(0, end)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const pairs: Array<{ key: string; value: string }> = [];
  for (let lineIndex = 0; lineIndex + 1 < lines.length; lineIndex += 2) {
    pairs.push({ key: lines[lineIndex].replace(/:$/, ""), value: lines[lineIndex + 1] });
  }
  return pairs;
}

export function extractDescriptionFromText(bodyText: string): string {
  const marker = "Description\n";
  const start = bodyText.indexOf(marker);
  if (start === -1) return "";
  const after = bodyText.slice(start + marker.length).trimStart();
  const afterLower = after.toLowerCase();
  const sectionEndMarkers = [
    "\ndetails\n",
    "shipping & pick-up options",
    "questions & answers",
    "seller's other listings",
    "similar listings",
    "you might also like",
  ];
  let end = after.length;
  for (const sectionEndMarker of sectionEndMarkers) {
    const idx = afterLower.indexOf(sectionEndMarker);
    if (idx !== -1 && idx < end) end = idx;
  }
  return after
    .slice(0, end)
    .replace(/\s*\nShow more\s*$/, "")
    .trim();
}

export function extractStructuredFromText(bodyText: string): Partial<ListingDetail> {
  let buyNowPrice: number | null = null;
  const bnMatch = bodyText.match(/Buy [Nn]ow\s*\n\s*\$([\d,]+(?:\.\d+)?)/);
  if (bnMatch) buyNowPrice = parseFloat(bnMatch[1].replace(/,/g, ""));

  let reserveStatus = "UNKNOWN";
  if (/No reserve/.test(bodyText)) reserveStatus = "NONE";
  else if (/Reserve met/.test(bodyText)) reserveStatus = "MET";
  else if (/Reserve not met/.test(bodyText)) reserveStatus = "NOT_MET";

  const pickupMatch = bodyText.match(/Pick up from ([^\n]+)/);
  const pickupLocation = pickupMatch ? pickupMatch[1].trim() : "";
  const shippingIdx = bodyText.indexOf("Shipping & pick-up options");
  const shippingSection = shippingIdx >= 0 ? bodyText.slice(shippingIdx) : "";
  const isPickupOnly =
    /Pick-?up only|pickup only/i.test(bodyText) ||
    (pickupLocation !== "" && !/North Island|South Island|NZ Post|Courier/i.test(shippingSection));
  const shippingAvailable = !isPickupOnly;
  const pickupAvailable = pickupLocation !== "";

  return { buyNowPrice, reserveStatus, shippingAvailable, pickupAvailable, pickupLocation };
}

// ── GraphQL extraction ────────────────────────────────────────────────────────

type GraphQLAttr = {
  key: string;
  numValue?: number;
  options?: Array<{ __typename: string; name: string }>;
};

function extractAttr(attrs: GraphQLAttr[], key: string): GraphQLAttr | undefined {
  return attrs.find((a) => a.key === key);
}

type GraphQLResponse = {
  data?: {
    listing?: {
      attributes?: GraphQLAttr[];
      contentViews?: {
        listingPurchaseContentCard?: {
          auctionDetails?: { reserveStatus?: string };
        };
      };
    };
  };
};

function extractFromGraphQL(json: unknown): Partial<ListingDetail> {
  const listing = (json as GraphQLResponse)?.data?.listing;
  if (!listing?.attributes) return {};
  const attrs = listing.attributes;
  const buyNowAttr = extractAttr(attrs, "BuyNowPrice");
  const deliveryAttr = extractAttr(attrs, "DeliveryOptions");
  const buyNowPrice: number | null = buyNowAttr?.numValue ?? null;
  const deliveryOptions: { __typename: string; name: string }[] = deliveryAttr?.options ?? [];
  const hasShipping = deliveryOptions.some((o) => o.__typename !== "PickupOption");
  const pickupOption = deliveryOptions.find((o) => o.__typename === "PickupOption");
  const pickupLocation = pickupOption?.name?.replace(/^Pick up from\s*/i, "") ?? "";
  const reserveStatus: string =
    listing?.contentViews?.listingPurchaseContentCard?.auctionDetails?.reserveStatus ?? "UNKNOWN";
  const pickupAvailable = pickupOption !== undefined;
  return {
    buyNowPrice,
    reserveStatus,
    shippingAvailable: hasShipping,
    pickupAvailable,
    pickupLocation,
  };
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

export async function fetchSingleListingDetailAsync(
  page: Page,
  url: string,
): Promise<ListingDetail> {
  let graphqlResult: Partial<ListingDetail> = {};

  const handler = async (response: Response) => {
    if (!response.url().includes("api.trademe.co.nz/graphql") || response.status() !== 200) return;
    try {
      const json = await response.json();
      const extracted = extractFromGraphQL(json);
      if (Object.keys(extracted).length > 0) {
        page.off("response", handler);
        graphqlResult = extracted;
      }
    } catch {
      /* ignore */
    }
  };
  page.on("response", handler);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page
    .waitForFunction(() => document.body.innerText.includes("Shipping & pick-up options"), {
      timeout: 10000,
    })
    .catch(() => {
      /* page may lack a shipping section — proceed with whatever rendered */
    });
  page.off("response", handler);

  const bodyText: string = await page.evaluate(() => document.body.innerText);
  const details = extractDetails(bodyText);
  const description = extractDescriptionFromText(bodyText);
  const dom = extractStructuredFromText(bodyText);
  const questionsAndAnswers = extractQuestionsAndAnswers(bodyText);

  return {
    details,
    description,
    buyNowPrice: graphqlResult.buyNowPrice ?? dom.buyNowPrice ?? null,
    reserveStatus:
      graphqlResult.reserveStatus && graphqlResult.reserveStatus !== "UNKNOWN"
        ? graphqlResult.reserveStatus
        : (dom.reserveStatus ?? "UNKNOWN"),
    shippingAvailable: graphqlResult.shippingAvailable ?? dom.shippingAvailable ?? null,
    pickupAvailable: graphqlResult.pickupAvailable ?? dom.pickupAvailable ?? null,
    pickupLocation: graphqlResult.pickupLocation || dom.pickupLocation || "",
    questionsAndAnswers,
  };
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
    if (siblings.length >= 1 && parentSlug && parentSlug.split("/").length >= MIN_COLLAPSIBLE_PARENT_DEPTH) {
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
): Promise<string[]> {
  const aiConfig = getAIConfig();
  const database = getDb();
  const broad = stmtGetCategoriesAtDepth2(database).all();
  const broadDisplayList = broad.map((category) => category.display).join("\n");

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
  if (selectedBroadSlugs.length < rawCategories.length)
    throw new Error("AI hallucination detected — please try again");

  const subcategoryPickResults = await Promise.all(
    selectedBroadSlugs.map((top2Slug) => {
      const broadEntry = broad.find((category) => category.slug === top2Slug);
      if (!broadEntry) throw new Error(`invariant: slug ${top2Slug} not found in broad categories`);
      const candidates = stmtGetCategoriesByTop2(database).all(top2Slug);
      const specificList = candidates
        .map((category) => `${category.display} (slug: ${category.slug})`)
        .join("\n");
      return aiJSON(
        aiConfig,
        `step2:${top2Slug}`,
        STEP2_SYSTEM_PROMPT,
        `I'm looking for: ${prompt.trim()}\n\nCategories within "${broadEntry.display}":\n${specificList}`,
        1024,
      ).then((result) => ({
        top2Slug,
        candidates,
        result: result as Record<string, unknown> | null,
      }));
    }),
  );

  const allEntries: DiscoverEntry[] = [];
  const step2Errors: string[] = [];
  for (const { top2Slug, candidates, result } of subcategoryPickResults) {
    const validSlugs = new Set(candidates.map((category) => category.slug));
    if (result === null || !Array.isArray(result.categories)) {
      step2Errors.push(`step2:${top2Slug} unexpected result`);
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
  if (urls.length === 0)
    throw new Error(`AI returned no valid specific categories. ${step2Errors.join("; ")}`);
  return urls;
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

    onEvent({ type: "progress", message: "Fetching page 1…" });
    const p1Promise = waitForSearchApiResponseAsync(page);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    let p1Listings: Listing[] = [];
    let totalCount = 0;
    let pageSize = 1;

    const p1FrendState = await page.evaluate(
      () => document.getElementById("frend-state")?.textContent ?? null,
    );
    if (p1FrendState) {
      try {
        const parsed = parseFrendState(JSON.parse(p1FrendState));
        if (parsed && parsed.listings.length > 0) {
          p1Listings = parsed.listings;
          totalCount = parsed.totalCount;
          pageSize = parsed.pageSize;
        }
      } catch {
        /* ignore */
      }
    }
    if (p1Listings.length === 0) {
      ({ listings: p1Listings, totalCount, pageSize } = await p1Promise);
    }

    const totalPages = Math.min(Math.ceil(totalCount / pageSize), MAX_PAGES_PER_SEARCH);

    onEvent({
      type: "progress",
      message: `${totalCount} results across ${totalPages} page${totalPages !== 1 ? "s" : ""}`,
    });

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
            onEvent({ type: "progress", message: `Fetching page ${pageNumber}/${totalPages}…` });
            const promise = waitForSearchApiResponseAsync(currentPage);
            await currentPage.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

            let listings: Listing[] = [];
            const frendStateText = await currentPage.evaluate(
              () => document.getElementById("frend-state")?.textContent ?? null,
            );
            if (frendStateText) {
              try {
                const parsed = parseFrendState(JSON.parse(frendStateText));
                if (parsed && parsed.listings.length > 0) listings = parsed.listings;
              } catch {
                /* ignore */
              }
            }
            if (listings.length === 0) {
              ({ listings } = await promise);
            }
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

export const trademeRecipe: Recipe = {
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
