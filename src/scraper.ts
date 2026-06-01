import { chromium, Response, Page } from 'playwright';

interface Listing {
  title: string;
  price: string;
  location: string;
  url: string;
}

interface ListingDetail {
  description: string;
  buyNowPrice: number | null;
  reserveStatus: string;
  pickupOnly: boolean;
  pickupLocation: string;
}

interface FilterCriteria {
  minPrice?: number;
  maxPrice?: number;
  keywords?: string[];
  excludeKeywords?: string[];
  minYear?: number;
}

const FILTERS: FilterCriteria = {
  excludeKeywords: ['part', 'repair', 'faulty', 'fault', 'i5', 'i7', 'A2338', 'A2289', 'A1708'],
  minYear: 2020,
};

const SEARCH_URL =
  'https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/search?' +
  'search_string=macbook%20pro' +
  '&condition=used' +
  '&RefinePanel5c34c1efa0ac468f91e15161d549c479=16%20to%2031%20gb' +
  '&RefinePanel7a2bb94c0cb44806ac995a4fc854bcbc=13%22' +
  '&RefinePanel7a2bb94c0cb44806ac995a4fc854bcbc=14%22' +
  '&RefinePanel7a2bb94c0cb44806ac995a4fc854bcbc=15%22';

const TRADEME_BASE = 'https://www.trademe.co.nz/a';

type ApiListing = Record<string, unknown>;

function priceToNumber(raw: string): number | null {
  const match = raw.replace(/,/g, '').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

function applyFilters(listing: Listing, filters: FilterCriteria): boolean {
  const titleLower = listing.title.toLowerCase();
  if (filters.keywords?.length) {
    if (!filters.keywords.every((kw) => titleLower.includes(kw.toLowerCase()))) return false;
  }
  if (filters.excludeKeywords?.length) {
    if (filters.excludeKeywords.some((kw) => titleLower.includes(kw.toLowerCase()))) return false;
  }
  const price = priceToNumber(listing.price);
  if (price !== null) {
    if (filters.minPrice !== undefined && price < filters.minPrice) return false;
    if (filters.maxPrice !== undefined && price > filters.maxPrice) return false;
  }
  if (filters.minYear !== undefined) {
    const years = [...listing.title.matchAll(/\b(20\d{2})\b/g)].map((m) => parseInt(m[1]));
    if (years.length > 0 && Math.max(...years) < filters.minYear) return false;
  }
  return true;
}

function parseApiResponse(data: Record<string, unknown>): { listings: Listing[]; totalCount: number } {
  const items = (data?.List ?? []) as ApiListing[];
  const totalCount = (data?.TotalCount as number) ?? 0;
  const listings: Listing[] = items
    .map((item) => {
      const canonicalPath = (item.CanonicalPath as string) ?? '';
      return {
        title: (item.Title as string) ?? '',
        price: (item.PriceDisplay as string) ?? 'Price on request',
        location: [(item.Suburb as string), (item.Region as string)].filter(Boolean).join(', ') || 'Unknown',
        url: canonicalPath ? `${TRADEME_BASE}${canonicalPath}` : '',
      };
    })
    .filter((l) => l.title && l.url);
  return { listings, totalCount };
}

function waitForSearchResponse(page: Page): Promise<{ listings: Listing[]; totalCount: number }> {
  return new Promise((resolve) => {
    const handler = async (response: Response) => {
      if (response.url().includes('api.trademe.co.nz/v1/search') && response.status() === 200) {
        page.off('response', handler);
        try {
          resolve(parseApiResponse(await response.json() as Record<string, unknown>));
        } catch {
          resolve({ listings: [], totalCount: 0 });
        }
      }
    };
    page.on('response', handler);
    setTimeout(() => { page.off('response', handler); resolve({ listings: [], totalCount: 0 }); }, 12000);
  });
}

// Extract description from rendered page text — works for all listing types
function extractDescriptionFromText(bodyText: string): string {
  const descMarker = 'Description\n';
  const startIdx = bodyText.indexOf(descMarker);
  if (startIdx === -1) return '';

  const afterDesc = bodyText.slice(startIdx + descMarker.length).trimStart();

  // End at common section headings that follow the description
  const endMarkers = [
    'Shipping & pick-up options',
    'Questions & answers',
    "Seller's other listings",
    'Similar listings',
    'You might also like',
  ];
  let endIdx = afterDesc.length;
  for (const marker of endMarkers) {
    const idx = afterDesc.indexOf(marker);
    if (idx !== -1 && idx < endIdx) endIdx = idx;
  }

  return afterDesc.slice(0, endIdx).trim();
}

// Extract structured fields from rendered page text as fallback
function extractStructuredFromText(bodyText: string): Partial<ListingDetail> {
  const text = bodyText;

  // Buy now price
  let buyNowPrice: number | null = null;
  const bnMatch = text.match(/Buy [Nn]ow\s*\n\s*\$([\d,]+(?:\.\d+)?)/);
  if (bnMatch) buyNowPrice = parseFloat(bnMatch[1].replace(/,/g, ''));

  // Reserve status
  let reserveStatus = 'UNKNOWN';
  if (/No reserve/.test(text)) reserveStatus = 'NONE';
  else if (/Reserve met/.test(text)) reserveStatus = 'MET';
  else if (/Reserve not met/.test(text)) reserveStatus = 'NOT_MET';

  // Pickup
  const pickupMatch = text.match(/Pick up from ([^\n]+)/);
  const pickupLocation = pickupMatch ? pickupMatch[1].trim() : '';
  const pickupOnly = /Pick-?up only|pickup only/i.test(text) ||
    (pickupLocation !== '' && !/North Island|South Island|Auckland|NZ Post|Courier/i.test(text.slice(text.indexOf('Shipping & pick-up options'))));

  return { buyNowPrice, reserveStatus, pickupOnly, pickupLocation };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAttr(attrs: any[], key: string): any | undefined {
  return attrs.find((a) => a.key === key);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFromGraphQL(json: any): Partial<ListingDetail> {
  const listing = json?.data?.listing;
  if (!listing?.attributes) return {};

  const attrs = listing.attributes;
  const buyNowAttr = extractAttr(attrs, 'BuyNowPrice');
  const deliveryAttr = extractAttr(attrs, 'DeliveryOptions');

  const buyNowPrice: number | null = buyNowAttr?.numValue ?? null;
  const deliveryOptions: { __typename: string; name: string }[] = deliveryAttr?.options ?? [];
  const hasShipping = deliveryOptions.some((o) => o.__typename !== 'PickupOption');
  const pickupOption = deliveryOptions.find((o) => o.__typename === 'PickupOption');
  const pickupLocation = pickupOption?.name?.replace(/^Pick up from\s*/i, '') ?? '';
  const reserveStatus: string =
    listing?.contentViews?.listingPurchaseContentCard?.auctionDetails?.reserveStatus ?? 'UNKNOWN';

  return { buyNowPrice, reserveStatus, pickupOnly: !hasShipping, pickupLocation };
}

async function fetchListingDetail(page: Page, url: string): Promise<ListingDetail> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let graphqlResult: Partial<ListingDetail> = {};

  const handler = async (response: Response) => {
    if (!response.url().includes('api.trademe.co.nz/graphql') || response.status() !== 200) return;
    try {
      const json = await response.json();
      const extracted = extractFromGraphQL(json);
      if (Object.keys(extracted).length > 0) {
        page.off('response', handler);
        graphqlResult = extracted;
      }
    } catch { /* ignore */ }
  };
  page.on('response', handler);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait long enough for both GraphQL and DOM rendering to complete
  await page.waitForTimeout(5000);
  page.off('response', handler);

  const bodyText: string = await page.evaluate(() => document.body.innerText);
  const description = extractDescriptionFromText(bodyText);
  const domStructured = extractStructuredFromText(bodyText);

  // Prefer GraphQL for structured fields; fall back to DOM
  return {
    description,
    buyNowPrice: graphqlResult.buyNowPrice ?? domStructured.buyNowPrice ?? null,
    reserveStatus: (graphqlResult.reserveStatus && graphqlResult.reserveStatus !== 'UNKNOWN')
      ? graphqlResult.reserveStatus
      : (domStructured.reserveStatus ?? 'UNKNOWN'),
    pickupOnly: graphqlResult.pickupOnly ?? domStructured.pickupOnly ?? false,
    pickupLocation: graphqlResult.pickupLocation || domStructured.pickupLocation || '',
  };
}

function formatReserve(status: string): string {
  if (status === 'NONE') return 'No reserve';
  if (status === 'MET') return 'Reserve met';
  if (status === 'NOT_MET') return 'Reserve not met';
  return 'Unknown';
}

async function scrape(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-NZ',
  });

  const page = await context.newPage();
  const allListings: Listing[] = [];

  console.log('Searching TradeMe for used MacBook Pro listings (16-31 GB RAM, 13"/14"/15")...\n');

  process.stdout.write('  Fetching page 1...');
  const page1Promise = waitForSearchResponse(page);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const { listings: firstPageListings, totalCount } = await page1Promise;
  const totalPages = Math.ceil(totalCount / 56);
  process.stdout.write(` (${totalCount} total results across ${totalPages} page${totalPages !== 1 ? 's' : ''})\n`);
  allListings.push(...firstPageListings);

  for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
    await page.waitForSelector('a[aria-label^="Next page"]', { timeout: 8000 }).catch(() => null);
    const nextBtn = page.locator('a[aria-label^="Next page"]').first();
    if (!await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) break;

    process.stdout.write(`  Fetching page ${pageNum}/${totalPages}...`);
    const nextPagePromise = waitForSearchResponse(page);
    await nextBtn.click();
    const { listings: nextListings } = await nextPagePromise;
    process.stdout.write(` ${nextListings.length} listings\n`);
    if (nextListings.length === 0) break;
    allListings.push(...nextListings);
    await page.waitForTimeout(500);
  }

  const filtered = allListings.filter((l) => applyFilters(l, FILTERS));

  if (filtered.length === 0) {
    console.log(allListings.length === 0
      ? '\nNo listings returned — the site may have changed structure.'
      : `\nNo listings matched your filters (${allListings.length} found before filtering).`);
    await browser.close();
    return;
  }

  console.log(`\nFetching details for ${filtered.length} listing${filtered.length !== 1 ? 's' : ''}...\n`);

  for (let i = 0; i < filtered.length; i++) {
    const listing = filtered[i];
    process.stdout.write(`  [${i + 1}/${filtered.length}] ${listing.title.slice(0, 60)}...`);
    const detail = await fetchListingDetail(page, listing.url);
    process.stdout.write(' done\n');

    console.log('\n' + '─'.repeat(80));
    console.log(`Title      : ${listing.title}`);
    console.log(`Price      : ${listing.price}`);
    console.log(`Buy Now    : ${detail.buyNowPrice != null ? `$${detail.buyNowPrice.toLocaleString()}` : 'N/A'}`);
    console.log(`Reserve    : ${formatReserve(detail.reserveStatus)}`);
    console.log(`Location   : ${listing.location}`);
    console.log(`Pickup     : ${detail.pickupLocation || listing.location}${detail.pickupOnly ? ' (pickup only)' : ''}`);
    console.log(`URL        : ${listing.url}`);
    console.log(`\nDescription:\n${detail.description || '(no description provided)'}`);
    console.log('─'.repeat(80));

    if (i < filtered.length - 1) await page.waitForTimeout(500);
  }

  await browser.close();
}

scrape().catch((err) => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});
