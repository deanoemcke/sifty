import { JSDOM } from 'jsdom';
import { chromium } from 'playwright';
import type {
  DeepSearchEvent,
  Listing,
  QuickSearchEvent,
  Recipe,
  ReserveStatus,
} from '../../lib/recipes/base';
import { requirePattern } from '../../lib/recipes/metadata';
import { hashFingerprintParts } from '../alerts';
import { MAX_PAGES_PER_SEARCH, MAX_RESULTS_PER_URL } from '../constants';
import { getDb, stmtGetCategoryByLegacyPath } from '../db';
import { parsePriceValue } from './trademe';
import type { DiscoverEntry } from './trademeCategoryResolver';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TRADEME_ORIGIN = 'https://www.trademe.co.nz';

const LEGACY_PATTERN = requirePattern('trademe-expired');

// ── cid/rptpath <-> legacy_path ─────────────────────────────────────────────────
// TradeMe's category JSON `Number` field (stored as `legacy_path`, e.g. "0002-0356-")
// already *is* the full cid/rptpath ancestor chain, zero-padded to 4 digits per segment
// — verified empirically against a real search: "Computers/Laptops" has legacy_path
// "0002-0356-", and stripping the padding gives exactly rptpath=2-356- with cid=356.

export function deriveLegacyCidAndRptpath(legacyPath: string): { cid: string; rptpath: string } {
  const segments = legacyPath
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => String(Number(segment)));
  return { cid: segments[segments.length - 1], rptpath: `${segments.join('-')}-` };
}

export function reconstructLegacyPathFromRptpath(rptpath: string): string {
  const segments = rptpath.split('-').filter((segment) => segment.length > 0);
  return `${segments.map((segment) => segment.padStart(4, '0')).join('-')}-`;
}

// ── Discover URL building ─────────────────────────────────────────────────────
// current=0 (closed listings) and sort_order=bids_asc (TradeMe's legacy code for the
// "Most bids" sort — there is no "least bids" option) are hardcoded, not user-configurable:
// they're what makes this recipe "expired, sold" rather than a generic search. searchregion
// is likewise hardcoded to 100 (nationwide) since this recipe always searches all regions.
// from=advanced&advanced=true are required to avoid TradeMe 301-redirecting to the modern
// site — verified empirically; omitting either one triggers the redirect.

function buildLegacySearchParams(
  cid: string,
  rptpath: string,
  searchString: string
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('cid', cid);
  params.set('rptpath', rptpath);
  params.set('searchstring', searchString);
  params.set('current', '0');
  params.set('sort_order', 'bids_asc');
  params.set('searchregion', '100');
  params.set('advanced', 'true');
  params.set('from', 'advanced');
  return params;
}

export function buildLegacySearchUrl(entry: DiscoverEntry, legacyPath: string): string {
  const { cid, rptpath } = deriveLegacyCidAndRptpath(legacyPath);
  const params = buildLegacySearchParams(cid, rptpath, entry.soldSearchString);
  return `${TRADEME_ORIGIN}/Browse/SearchResults.aspx?${params.toString()}`;
}

// cid=0 & rptpath=all is TradeMe's own "all categories" sentinel on the legacy
// SearchResults.aspx endpoint — verified empirically against a real search: it
// returns closed listings spanning multiple categories rather than a redirect
// or error. Lets the discover root-search-probe path (trademe.ts), which never
// resolves an AI category, still build a sold-items URL without a legacy_path.
export function buildRootLegacySearchUrl(searchString: string): string {
  const params = buildLegacySearchParams('0', 'all', searchString);
  return `${TRADEME_ORIGIN}/Browse/SearchResults.aspx?${params.toString()}`;
}

// ── Implicit filter extraction ────────────────────────────────────────────────
// current/sort_order/searchregion/advanced/from are forced by this recipe, not filters
// the user chose, so (unlike trademe.ts's extractImplicitFilters) they're never shown.

export function extractImplicitFilters(urlStr: string): Array<[string, string]> {
  try {
    const url = new URL(urlStr);
    const filterRows: Array<[string, string]> = [];

    const rptpath = url.searchParams.get('rptpath');
    if (rptpath) {
      const legacyPath = reconstructLegacyPathFromRptpath(rptpath);
      const row = stmtGetCategoryByLegacyPath(getDb()).get(legacyPath);
      if (row) {
        // Only the last two breadcrumb sections — matches trademe.ts's normal-listing display.
        const cat = row.display.split(' > ').slice(-2).join(' > ');
        filterRows.push(['Category', cat]);
      }
    }

    const searchstring = url.searchParams.get('searchstring');
    if (searchstring) filterRows.push(['Search', searchstring]);

    // Every URL this recipe handles is a closed/sold-listings search (see current=0 above).
    filterRows.push(['Availability', 'SOLD']);

    return filterRows;
  } catch {
    return [];
  }
}

// ── Search results page parsing ───────────────────────────────────────────────
// The legacy site server-renders each listing as a `.listingCard` — verified against a
// real captured page (see __fixtures__/trademe-legacy-search.html). Only bid-based auction
// listings are in scope (this recipe's purpose is sold-price research): a card with no
// `.listingNumberOfBidsText` (e.g. a Buy-Now-only listing) is skipped, not counted as sold
// or unsold. Results are sorted most-bids-first (see buildLegacySearchUrl), so the first
// zero-bid card means every remaining card on every remaining page is also unsold — callers
// use `reachedZeroBids` to stop paginating rather than scanning further.

const BID_COUNT_PATTERN = /(\d+)\s*bids?/i;

function mapLegacyReserveText(text: string | undefined): ReserveStatus {
  if (text === undefined) return 'NONE';
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'reserve not met') return 'NOT_MET';
  if (normalized === 'reserve met') return 'MET';
  console.warn(`[trademeExpired] unrecognized reserve text: ${JSON.stringify(text)}`);
  return 'UNKNOWN';
}

export function parseLegacySearchResultsHtml(html: string): {
  listings: Listing[];
  reachedZeroBids: boolean;
} {
  const document = new JSDOM(html).window.document;
  const listings: Listing[] = [];
  let reachedZeroBids = false;

  for (const card of Array.from(document.querySelectorAll('.listingCard'))) {
    const bidCountText = card.querySelector('.listingNumberOfBidsText')?.textContent ?? '';
    const bidCountMatch = bidCountText.match(BID_COUNT_PATTERN);
    if (!bidCountMatch) continue;
    if (Number(bidCountMatch[1]) === 0) {
      reachedZeroBids = true;
      break;
    }

    const titleAnchor = card.querySelector('.listingTitle a');
    const title = titleAnchor?.textContent?.trim();
    const href = titleAnchor?.getAttribute('href');
    if (!title || !href) continue;

    const priceText = card.querySelector('.listingBidPrice')?.textContent ?? '';
    const thumbnailUrl = card.querySelector('.listingImage img')?.getAttribute('src') ?? undefined;
    const reserveText = card.querySelector('.reserve-text')?.textContent?.trim();
    const reserveStatus = mapLegacyReserveText(reserveText);

    listings.push({
      source: LEGACY_PATTERN.name,
      title,
      price: parsePriceValue(priceText),
      location: card.querySelector('.listingLocation')?.textContent?.trim() || 'Unknown',
      url: href.startsWith('http') ? href : `${TRADEME_ORIGIN}${href}`,
      isAuction: true,
      thumbnailUrl,
      // Positive allowlist, not an exclusion of NOT_MET: an unrecognized reserve
      // badge (UNKNOWN) must fail safe as not-sold rather than silently reporting
      // a sale that may not have happened.
      isSold: reserveStatus === 'MET' || reserveStatus === 'NONE',
      reserveStatus,
      relevance: 0,
    });
  }

  return { listings, reachedZeroBids };
}

// ── Recipe implementation ─────────────────────────────────────────────────────

async function quickSearchAsync(
  searchUrl: string,
  onEvent: (event: QuickSearchEvent) => void,
  isCancelled?: () => boolean
): Promise<void> {
  onEvent({ type: 'criteria', filters: extractImplicitFilters(searchUrl) });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-NZ' });
    const page = await context.newPage();

    const seenUrls = new Set<string>();
    let foundSoFar = 0;
    for (let pageNumber = 1; pageNumber <= MAX_PAGES_PER_SEARCH; pageNumber++) {
      if (isCancelled?.()) break;

      onEvent({ type: 'progress', phase: 'paging', page: pageNumber });
      const pageUrlInstance = new URL(searchUrl);
      pageUrlInstance.searchParams.set('page', String(pageNumber));
      await page.goto(pageUrlInstance.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const html = await page.content();
      const { listings, reachedZeroBids } = parseLegacySearchResultsHtml(html);
      if (listings.length === 0 && !reachedZeroBids) break; // no more pages

      for (const listing of listings) {
        if (foundSoFar >= MAX_RESULTS_PER_URL) break;
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        foundSoFar++;
        onEvent({ type: 'listing', data: listing });
      }
      const cappedAtLimit = foundSoFar >= MAX_RESULTS_PER_URL;
      onEvent({
        type: 'progress',
        phase: 'collecting',
        foundSoFar,
        isLoadingMore: !reachedZeroBids && !cappedAtLimit,
      });

      if (reachedZeroBids || cappedAtLimit) break;
    }

    onEvent({ type: 'complete' });
  } catch (error) {
    onEvent({ type: 'error', message: (error as Error).message });
  } finally {
    await browser.close();
  }
}

// This recipe's listings already carry everything it cares about (price, bid-derived
// sold status, location) from quickSearch alone — there's no additional per-listing
// detail page to fetch, so deep search is a no-op rather than a Playwright-driven
// re-scrape of an archived listing page.
async function deepSearchAsync(
  _listings: Listing[],
  onEvent: (event: DeepSearchEvent) => void
): Promise<void> {
  onEvent({ type: 'complete' });
}

// Mirrors trademe.ts's choice (thumbnailUrl over price) for consistency
// within the same TradeMe CDN family, though these listings are expired
// (bidding already finalized) so price would be equally stable here.
function computeAlertFingerprint(listing: Listing): string {
  return hashFingerprintParts([
    listing.title,
    listing.location,
    listing.description,
    listing.thumbnailUrl,
  ]);
}

export const trademeExpiredRecipe: Recipe = {
  name: LEGACY_PATTERN.name,
  matches(url: string): boolean {
    try {
      const { hostname, pathname } = new URL(url);
      return hostname.endsWith(LEGACY_PATTERN.hostname) && pathname === LEGACY_PATTERN.pathPrefix;
    } catch {
      return false;
    }
  },
  extractImplicitFilters,
  quickSearchAsync,
  deepSearchAsync,
  computeAlertFingerprint,
};
