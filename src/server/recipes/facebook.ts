import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { enqueue } from '../../lib/queue';
import type {
  AiConfig,
  DeepSearchDetail,
  DeepSearchEvent,
  DiscoverableRecipe,
  DiscoverContext,
  Fulfillment,
  Listing,
  ListingCondition,
  ListingPhoto,
  QuickSearchEvent,
} from '../../lib/recipes/base';
import { requirePattern } from '../../lib/recipes/metadata';
import { aiJSON, applyAiJsonResult } from '../ai';
import { hashFingerprintParts } from '../alerts';
import { MAX_RESULTS_PER_URL } from '../constants';
import { getRegions, type RegionEntry } from '../services/regions';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FACEBOOK_BASE = 'https://www.facebook.com';

const FACEBOOK_PATTERN = requirePattern('facebook');

// ── Implicit filter extraction ────────────────────────────────────────────────

export function extractImplicitFilters(urlStr: string): Array<[string, string]> {
  try {
    const url = new URL(urlStr);
    const filterRows: Array<[string, string]> = [];

    const query = url.searchParams.get('query');
    if (query) filterRows.push(['Search', query]);

    if (url.searchParams.get('availability') === 'out of stock') {
      filterRows.push(['Availability', 'SOLD']);
    }

    const minPrice = url.searchParams.get('minPrice');
    const maxPrice = url.searchParams.get('maxPrice');
    if (minPrice && maxPrice) filterRows.push(['Price', `$${minPrice} – $${maxPrice}`]);
    else if (minPrice) filterRows.push(['Min Price', `$${minPrice}`]);
    else if (maxPrice) filterRows.push(['Max Price', `$${maxPrice}`]);

    const condition = url.searchParams.get('itemCondition');
    if (condition) filterRows.push(['Condition', condition]);

    const daysSinceListed = url.searchParams.get('daysSinceListed');
    if (daysSinceListed) filterRows.push(['Listed within', `${daysSinceListed} days`]);

    const sortBy = url.searchParams.get('sortBy');
    if (sortBy) filterRows.push(['Sort', sortBy]);

    return filterRows;
  } catch {
    return [];
  }
}

// ── Browser context ───────────────────────────────────────────────────────────

const LOGIN_REQUIRED_MESSAGE = 'Facebook requires login. Set FB_COOKIES environment variable.';

export class MissingFacebookCookiesError extends Error {
  constructor(reason: string) {
    super(reason ? `${LOGIN_REQUIRED_MESSAGE} ${reason}` : LOGIN_REQUIRED_MESSAGE);
    this.name = 'MissingFacebookCookiesError';
  }
}

type RawFacebookCookie = Record<string, unknown>;

function cookieExpirySeconds(cookie: RawFacebookCookie): number | undefined {
  if (typeof cookie.expirationDate === 'number') return cookie.expirationDate;
  if (typeof cookie.expires === 'number') return cookie.expires;
  return undefined;
}

// FB_COOKIES: JSON array of cookies exported from your browser (e.g. via the
// "Cookie Editor" extension — Export > Export as JSON). Validated up front so a
// missing/malformed/expired cookie set fails immediately, before any browser is
// launched or network request made, instead of only surfacing after a full,
// doomed scrape attempt.
export function parseFbCookies(cookiesJson: string | undefined): RawFacebookCookie[] {
  if (!cookiesJson) throw new MissingFacebookCookiesError('');

  let raw: unknown;
  try {
    raw = JSON.parse(cookiesJson);
  } catch {
    throw new MissingFacebookCookiesError('FB_COOKIES is not valid JSON.');
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MissingFacebookCookiesError('FB_COOKIES must be a non-empty JSON array of cookies.');
  }

  const nowSeconds = Date.now() / 1000;
  const unexpired = (raw as RawFacebookCookie[]).filter((cookie) => {
    const expiry = cookieExpirySeconds(cookie);
    return expiry === undefined || expiry > nowSeconds;
  });

  if (unexpired.length === 0) {
    throw new MissingFacebookCookiesError('All cookies in FB_COOKIES have expired.');
  }

  return unexpired;
}

function toPlaywrightCookies(
  cookies: RawFacebookCookie[]
): Parameters<BrowserContext['addCookies']>[0] {
  return cookies.map((cookie) => ({
    name: String(cookie.name),
    value: String(cookie.value),
    domain: String(cookie.domain ?? '.facebook.com'),
    path: String(cookie.path ?? '/'),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: (['Strict', 'Lax', 'None'].includes(String(cookie.sameSite))
      ? cookie.sameSite
      : 'Lax') as 'Strict' | 'Lax' | 'None',
    ...(typeof cookie.expirationDate === 'number'
      ? { expires: cookie.expirationDate }
      : typeof cookie.expires === 'number'
        ? { expires: cookie.expires }
        : {}),
  }));
}

async function createContext(): Promise<{ browser: Browser; context: BrowserContext }> {
  const cookies = parseFbCookies(process.env.FB_COOKIES);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-NZ' });
  await context.addCookies(toPlaywrightCookies(cookies));
  console.log(`[facebook] loaded ${cookies.length} cookies from FB_COOKIES`);

  return { browser, context };
}

// tsx (used by the scheduler) transforms with esbuild's keepNames:true, which
// injects `__name(fn, "fn")` calls after named function declarations. When such
// a declaration is nested inside a page.evaluate/addInitScript closure, that
// injected call becomes part of what Playwright serializes into the browser via
// toString() — but the real __name helper lives in tsx's bundle, not the
// browser, so it throws ReferenceError. Installing this passthrough as its own
// page-level init script (rather than folded into maskHeadless's closure below)
// means any such call resolves, and keeps the shim callable directly in tests
// without needing navigator/window.
export function installNameShim(): void {
  (globalThis as { __name?: (fn: unknown) => unknown }).__name ??= (fn: unknown) => fn;
}

async function maskHeadless(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // @ts-expect-error
    if (!window.chrome) window.chrome = { runtime: {} };
  });
  await page.addInitScript(installNameShim);
}

// ── Login wall detection ────────────────────────────────────────────────────
//
// One shared detector, used at every point a login wall can appear (quick search,
// immediately after load and again after listings start rendering; deep search's
// per-listing detail fetch) instead of the three previously-inconsistent ad-hoc
// checks. Combines a precise DOM-selector check with a URL check and a body-text
// heuristic fallback, so markup changes Facebook makes don't silently blind the
// selector check.

export function isLoginWallUrl(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith('/login');
  } catch {
    return false;
  }
}

export function isLoginWallText(snippet: string): boolean {
  const lower = snippet.toLowerCase();
  return lower.includes('log in') || lower.includes('sign up');
}

async function evaluateLoginWallSignals(
  page: Page
): Promise<{ domMatch: boolean; textSnippet: string }> {
  return page
    .evaluate(() => ({
      domMatch:
        !!document.getElementById('login_popup_cta_form') ||
        !!document.querySelector('form[action*="/login/device-based/"]') ||
        (!!document.querySelector('input[name="email"]') &&
          !!document.querySelector('input[name="pass"]')),
      textSnippet: document.body.innerText.slice(0, 300),
    }))
    .catch(() => ({ domMatch: false, textSnippet: '' }));
}

export async function detectLoginWallAsync(page: Page): Promise<boolean> {
  if (isLoginWallUrl(page.url())) return true;
  const { domMatch, textSnippet } = await evaluateLoginWallSignals(page);
  return domMatch || isLoginWallText(textSnippet);
}

// ── Empty-results detection ─────────────────────────────────────────────────
//
// A genuine zero-result search is distinguishable from a block/interstitial: it
// renders the full Marketplace shell plus an explicit empty-state sentence
// (captured live, en-NZ locale: `No listings found for "<query>" within 60
// kilometres` / `Try a new search. Check the spelling, change your filters or
// try a less specific search term.`). Both the shell AND a sentence are
// required — a soft-block where the shell renders but the results pane never
// populates must keep falling through to the blocking error rather than being
// misreported as zero results. The locale is forced to en-NZ at context
// creation, so the English wording is stable.

const EMPTY_RESULTS_PHRASES = ['no listings found', 'try a new search'];
const MARKETPLACE_SHELL_SELECTOR = 'input[aria-label="Search Marketplace" i]';

export function isEmptyResultsText(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return EMPTY_RESULTS_PHRASES.some((phrase) => lower.includes(phrase));
}

async function evaluateEmptyStateSignals(
  page: Page
): Promise<{ shellRendered: boolean; bodyText: string }> {
  return page
    .evaluate(
      (shellSelector: string) => ({
        shellRendered: !!document.querySelector(shellSelector),
        bodyText: document.body.innerText,
      }),
      MARKETPLACE_SHELL_SELECTOR
    )
    .catch(() => ({ shellRendered: false, bodyText: '' }));
}

// ── Listing extraction via MutationObserver ───────────────────────────────────

const LISTING_ANCHOR_SELECTOR = 'a[href*="/marketplace/item/"]';

export const PRICE_REGEX = /^(?:[A-Z]{0,3}\$)[\d,]+(?:\.\d{2})?$|^Free$/;

export function parseFacebookPriceValue(priceLine: string | undefined): number | null {
  if (priceLine === undefined) return null;
  if (priceLine === 'Free') return 0;
  const match = priceLine.replace(/,/g, '').match(/[\d.]+/);
  if (!match) return null;
  const parsed = parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

// A sold/pending listing's price row renders as three separate flex items — the
// status word ("Sold" or "Pending"), a "·" separator, then the price — and each
// flex item forces its own line in `innerText`. So they arrive as three distinct
// lines, not one combined "Sold · NZ$100" line. A status word only counts as the
// sold/pending marker when the very next line is the separator — that adjacency
// distinguishes the real marker from a title or location that happens to be
// literally "Sold" or "Pending". Matched status lines are stripped (along with
// bare separator lines) here, at the point lines are normalized, so every
// downstream consumer (price parsing, title/location fallback) sees a clean
// line set and doesn't need to know about the status marker.
const STATUS_LINE_REGEX = /^(?:Sold|Pending)$/i;
const SEPARATOR_LINE_REGEX = /^·$/;
// Fallback for the alternative markup shape where the status row renders as one
// combined line ("Sold · NZ$50") instead of three flex-item lines. The status
// word plus the "·" separator at the start of a line is the sold/pending marker;
// the remainder (normally the price) is kept as its own line so downstream
// price/title/location parsing sees the same clean line set as the three-line
// shape. If the remainder is not a parseable price the anomaly is logged rather
// than silently discarded.
const COMBINED_STATUS_LINE_REGEX = /^(?:Sold|Pending)\s*·\s*(.+)$/i;

export function parseFacebookPriceLines(innerText: string): {
  price: number | null;
  isSold: boolean;
  lines: string[];
} {
  const rawLines = innerText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const statusLineIndices = new Set<number>();
  for (let lineIndex = 0; lineIndex < rawLines.length - 1; lineIndex++) {
    if (
      STATUS_LINE_REGEX.test(rawLines[lineIndex]) &&
      SEPARATOR_LINE_REGEX.test(rawLines[lineIndex + 1])
    ) {
      statusLineIndices.add(lineIndex);
    }
  }
  let isSold = statusLineIndices.size > 0;

  const lines: string[] = [];
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const line = rawLines[lineIndex];
    if (statusLineIndices.has(lineIndex) || SEPARATOR_LINE_REGEX.test(line)) continue;
    const combinedMatch = line.match(COMBINED_STATUS_LINE_REGEX);
    if (combinedMatch) {
      isSold = true;
      const remainder = combinedMatch[1].trim();
      if (!PRICE_REGEX.test(remainder)) {
        console.warn(`[facebook] combined status line has an unparseable price: "${line}"`);
      }
      lines.push(remainder);
      continue;
    }
    lines.push(line);
  }

  const priceLines = lines.filter((line) => PRICE_REGEX.test(line));
  const price = parseFacebookPriceValue(priceLines[0]);
  return { price, isSold, lines };
}

export function buildFacebookListing(
  url: string,
  thumbnailUrl: string | undefined,
  title: string,
  price: number | null,
  location: string,
  isSold = false
): Listing {
  return {
    source: FACEBOOK_PATTERN.name,
    title,
    price,
    location,
    url,
    thumbnailUrl,
    isAuction: false,
    relevance: 0,
    isSold,
  };
}

// Called from browser-side MutationObserver via page.exposeFunction.
// Runs in Node.js; returns void (browser side fire-and-forgets).
export type RawListingMsg = {
  id: string;
  url: string;
  ariaLabel: string;
  innerText: string;
  thumbnailUrl: string;
};

export function processRawListing(
  raw: RawListingMsg,
  seen: Set<string>,
  onEvent: (event: QuickSearchEvent) => void,
  counter: { total: number }
): void {
  if (seen.has(raw.id)) return;
  seen.add(raw.id);
  if (counter.total >= MAX_RESULTS_PER_URL) return;

  const { price, lines: innerLines, isSold } = parseFacebookPriceLines(raw.innerText);

  let title = '',
    location = 'Unknown';
  const ariaLabel = raw.ariaLabel.replace(/,\s*listing\s+\d+\s*$/i, '').trim();
  const labelMatch = ariaLabel.match(/^(.+?),\s*(?:[A-Z]{0,3}\$[\d,]+(?:\.\d{2})?|Free),\s*(.+)$/);
  if (labelMatch) {
    title = labelMatch[1].trim();
    location = labelMatch[2].trim();
  }
  if (!title) {
    location = innerLines[innerLines.length - 1] ?? 'Unknown';
    title = innerLines.find((line) => !PRICE_REGEX.test(line) && line !== location) ?? '';
  }
  if (!title) return;

  counter.total++;
  onEvent({
    type: 'listing',
    data: buildFacebookListing(
      raw.url,
      raw.thumbnailUrl || undefined,
      title,
      price,
      location,
      isSold
    ),
  });
}

// ── Initial search state classification ───────────────────────────────────────

export type InitialSearchOutcome = 'listings' | 'empty' | 'blocked';

// Races listings-appear vs. empty-state vs. neither, then resolves the outcome
// down to a single tri-state result. Pure classification — no events, no login
// wall handling (that stays in the caller, which already has its own tested
// `detectLoginWallAsync` helper and decides which error message to emit).
export async function classifyInitialSearchStateAsync(page: Page): Promise<InitialSearchOutcome> {
  // Wait for whichever renders first: listing anchors, or the empty-state
  // marker (Marketplace shell + empty-state sentence). Promise.any resolves
  // with the first *fulfilled* wait — a timed-out loser's rejection is
  // absorbed — and rejects only when both time out ('none').
  const firstSignal = await Promise.any([
    page
      .waitForSelector(LISTING_ANCHOR_SELECTOR, { timeout: 15000 })
      .then(() => 'listings' as const),
    page
      .waitForFunction(
        ({ phrases, shellSelector }) => {
          if (!document.querySelector(shellSelector)) return false;
          const lower = (document.body.innerText || '').toLowerCase();
          return phrases.some((phrase) => lower.includes(phrase));
        },
        { phrases: EMPTY_RESULTS_PHRASES, shellSelector: MARKETPLACE_SHELL_SELECTOR },
        // polling: 500 — the default 'raf' mode would re-read body.innerText
        // (forcing a layout pass) every animation frame for the full 15s even
        // after losing the Promise.any race; the empty-state marker is static
        // once rendered, so 500ms granularity costs nothing.
        { timeout: 15000, polling: 500 }
      )
      .then(() => 'empty' as const),
  ]).catch(() => 'none' as const);

  let outcome: InitialSearchOutcome;
  if (firstSignal === 'listings') {
    outcome = 'listings';
  } else if (firstSignal === 'empty') {
    // The empty marker won the race — give late-rendering listings a short
    // grace window before trusting it, in case a page variant shows the
    // sentence alongside (still-loading) suggestion listings. Listings win.
    const listingsAppearedLate = await page
      .waitForSelector(LISTING_ANCHOR_SELECTOR, { timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    outcome = listingsAppearedLate ? 'listings' : 'empty';
  } else {
    // Both waits timed out — re-check once on the settled page: covers the
    // marker rendering exactly as both waits timed out, and supplies the body
    // snippet for diagnostics if this turns out to be a genuine block.
    const { shellRendered, bodyText } = await evaluateEmptyStateSignals(page);
    if (shellRendered && isEmptyResultsText(bodyText)) {
      outcome = 'empty';
    } else {
      console.log(
        `[facebook] no listings and no empty-state marker — body snippet: ${bodyText.slice(0, 300)}`
      );
      outcome = 'blocked';
    }
  }

  console.log(
    `[facebook] first signal: ${firstSignal}, classified as: ${outcome} — url: ${page.url()}`
  );
  return outcome;
}

// ── Quick search ──────────────────────────────────────────────────────────────

async function quickSearchAsync(
  searchUrl: string,
  onEvent: (event: QuickSearchEvent) => void,
  isCancelled?: () => boolean
): Promise<void> {
  onEvent({ type: 'criteria', filters: extractImplicitFilters(searchUrl) });

  // Each quick search launches its own authenticated headless browser off the
  // shared FB_COOKIES session, and a sold-items discover produces two Facebook
  // URLs that the frontend fires concurrently. Route the launch through the
  // per-domain concurrency limiter — the same one deepSearchAsync uses — so
  // concurrent searches can't stack unbounded logged-in sessions on one cookie
  // jar. The criteria event is emitted before queueing so the card gets its
  // filter chips immediately, even while the search waits for a slot.
  await enqueue(searchUrl, () => runQuickSearchAsync(searchUrl, onEvent, isCancelled));
}

async function runQuickSearchAsync(
  searchUrl: string,
  onEvent: (event: QuickSearchEvent) => void,
  isCancelled?: () => boolean
): Promise<void> {
  let browser: Browser | undefined;
  try {
    const browserSetup = await createContext();
    browser = browserSetup.browser;
    const page = await browserSetup.context.newPage();
    await maskHeadless(page);

    const seen = new Set<string>();
    const counter = { total: 0 };

    // Bridge: browser → Node.js. Called by the MutationObserver for every new listing link.
    await page.exposeFunction('fbListingFound', (raw: RawListingMsg) => {
      processRawListing(raw, seen, onEvent, counter);
    });

    onEvent({ type: 'progress', phase: 'loading' });
    console.log(`[facebook] fetching: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`[facebook] loaded — url: ${page.url()}`);

    // Dismiss cookie consent if present
    const cookieBtn = page.locator(
      '[aria-label="Allow all cookies"], [title="Allow all cookies"], [data-cookiebanner="accept_button"]'
    );
    if (
      await cookieBtn
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false)
    ) {
      await cookieBtn.first().click();
      await page.waitForTimeout(1000);
    }

    // Check for a login wall immediately — it's present in the DOM as soon as the
    // page loads, so this catches it well before the 15s listings-selector wait below
    // would otherwise be needed to notice the same thing.
    if (await detectLoginWallAsync(page)) {
      onEvent({ type: 'error', message: LOGIN_REQUIRED_MESSAGE });
      return;
    }

    const initialSearchState = await classifyInitialSearchStateAsync(page);

    if (initialSearchState !== 'listings') {
      if (await detectLoginWallAsync(page)) {
        onEvent({ type: 'error', message: LOGIN_REQUIRED_MESSAGE });
        return;
      }
      if (initialSearchState === 'empty') {
        console.log('[facebook] empty results — the search genuinely matched no listings');
        onEvent({ type: 'complete' });
        return;
      }
      onEvent({
        type: 'error',
        message:
          'No listings found. Facebook may be blocking access or the search returned no results.',
      });
      return;
    }

    // Inject MutationObserver — captures every listing link the moment it enters the DOM,
    // before virtualisation can remove it. Also processes all already-rendered links.
    await page.evaluate(
      ({ base, anchorSelector }: { base: string; anchorSelector: string }) => {
        function processLink(link: Element) {
          const href = link.getAttribute('href') ?? '';
          // Same URL shape as `anchorSelector` above; kept as a regex here because the
          // selector only matches, it doesn't capture the id.
          const match = href.match(/\/marketplace\/item\/(\d+)\//);
          if (!match) return;
          const img = link.querySelector('img');
          // biome-ignore lint/suspicious/noExplicitAny: Playwright-evaluated script; window is the browser's window, not typed
          (window as any).fbListingFound({
            id: match[1],
            url: `${base}/marketplace/item/${match[1]}/`,
            ariaLabel: link.getAttribute('aria-label') ?? '',
            innerText: (link as HTMLElement).innerText ?? '',
            thumbnailUrl: img ? (img as HTMLImageElement).src : '',
          });
        }

        document.querySelectorAll(anchorSelector).forEach(processLink);

        new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== 1) continue;
              const addedElement = node as Element;
              if (addedElement.matches(anchorSelector)) processLink(addedElement);
              addedElement.querySelectorAll(anchorSelector).forEach(processLink);
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
      },
      { base: FACEBOOK_BASE, anchorSelector: LISTING_ANCHOR_SELECTOR }
    );

    console.log(`[facebook] observer injected — initial: ${counter.total} listings`);
    if (counter.total > 0)
      onEvent({
        type: 'progress',
        phase: 'collecting',
        foundSoFar: counter.total,
        isLoadingMore: false,
      });

    // A login wall can also appear only after the observer is injected (e.g. a wall
    // that renders asynchronously) — check again here so we skip the scroll loop and
    // report the partial results already collected.
    const loginWallDetected = await detectLoginWallAsync(page);

    console.log(`[facebook] loginWallDetected: ${loginWallDetected}`);

    if (loginWallDetected) {
      console.log(`[facebook] login wall detected — only ${counter.total} listings available`);
      onEvent({
        type: 'error',
        message: `Login wall detected — only ${counter.total} listing${counter.total !== 1 ? 's' : ''} loaded. Set the FB_COOKIES environment variable to get full results.`,
      });
      return;
    }

    // Scroll loop — just drives scrolling; extraction is handled by the observer above
    let noNewCount = 0;
    let lastTotal = 0;
    for (;;) {
      if (isCancelled?.()) break;
      if (counter.total >= MAX_RESULTS_PER_URL) break;
      const bodyText: string = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes('Results from outside your search')) break;

      // Simulate real scroll events — window.scrollTo alone doesn't trigger FB's
      // infinite scroll listener; mouse wheel + End key are more reliable.
      await page.mouse.wheel(0, 3000);
      await page.keyboard.press('End');
      await page.waitForTimeout(1500);

      if (counter.total > lastTotal) {
        onEvent({
          type: 'progress',
          phase: 'collecting',
          foundSoFar: counter.total,
          isLoadingMore: true,
        });
        noNewCount = 0;
        lastTotal = counter.total;
      } else {
        if (++noNewCount >= 5) break;
      }
    }

    console.log(`[facebook] complete — ${counter.total} listings emitted`);
    onEvent({ type: 'complete' });
  } catch (error) {
    console.log(`[facebook] error:`, error);
    onEvent({ type: 'error', message: (error as Error).message });
  } finally {
    await browser?.close();
  }
}

// ── Detail extraction ─────────────────────────────────────────────────────────
//
// Facebook renders "Details", "Ads", "Seller information", and "Today's picks"
// as sibling <h2> sections sharing identical (Facebook-hashed) CSS classes, so
// there's no stable class/testid to scope to. But the Details heading's own
// card is structurally the smallest ancestor of its <h2> that contains exactly
// one <h2> descendant — climbing further would pull in the next section's
// heading too. That gives a DOM-structural boundary that keeps ad copy, seller
// info, and suggested-listing titles out of the scraped data entirely, instead
// of relying on string/punctuation heuristics to skip them after the fact.
//
// Attribute rows (Condition, Colour, ...) use a real DOM attribute —
// `justify="all"` on a two-child row — so they're read directly rather than
// guessed from line length/punctuation.
//
// This function is passed directly to page.evaluate() (Playwright serializes
// it via toString() and runs it in-browser), so it must stay self-contained —
// no closures over outer module consts, only DOM globals.
export interface FacebookDetailsCardData {
  cardInnerText: string;
  attributeRowCount: number;
  attributePairs: Record<string, string>;
}

export function extractFacebookDetailsCardData(): FacebookDetailsCardData | null {
  const headings = Array.from(document.querySelectorAll('h2'));
  const detailsHeading = headings.find((heading) => heading.textContent?.trim() === 'Details');
  if (!detailsHeading) return null;

  let ancestor: HTMLElement | null = detailsHeading;
  let cardEl: HTMLElement = detailsHeading;
  for (let depth = 0; ancestor && depth < 12; depth++) {
    if (ancestor.querySelectorAll('h2').length === 1) cardEl = ancestor;
    ancestor = ancestor.parentElement;
  }

  const rows = Array.from(cardEl.querySelectorAll('div[justify="all"]'));
  const attributePairs: Record<string, string> = {};
  for (const row of rows) {
    const children = Array.from(row.children) as HTMLElement[];
    if (children.length === 2) {
      attributePairs[children[0].innerText.trim()] = children[1].innerText.trim();
    }
  }

  return { cardInnerText: cardEl.innerText, attributeRowCount: rows.length, attributePairs };
}

const LOCATION_LINE_REGEX = /^(.*?)\s*·\s*Location is approximate$/;
const SEE_MORE_OR_LESS_SUFFIX_REGEX = /\s*See (more|less)\s*$/;

export function deriveFacebookDescriptionAndLocation(
  cardInnerText: string,
  attributeRowCount: number
): { description: string; pickupLocation: string | null } {
  const lines = cardInnerText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Skip the "Details" heading plus the known count of key/value attribute
  // lines — counted from the DOM, not guessed from line shape.
  let remaining = lines.slice(1 + attributeRowCount * 2);

  let pickupLocation: string | null = null;
  if (remaining.length > 0) {
    const locationMatch = remaining[remaining.length - 1].match(LOCATION_LINE_REGEX);
    if (locationMatch) {
      pickupLocation = locationMatch[1].trim();
      remaining = remaining.slice(0, -1);
    }
  }

  // Facebook glues the "See more"/"See less" toggle onto the end of the last
  // content line inline, rather than rendering it as its own line.
  if (remaining.length > 0) {
    remaining[remaining.length - 1] = remaining[remaining.length - 1]
      .replace(SEE_MORE_OR_LESS_SUFFIX_REGEX, '')
      .trim();
    remaining = remaining.filter((line) => line.length > 0);
  }

  return { description: remaining.join('\n').trim(), pickupLocation };
}

export function buildFacebookDeepSearchDetail(
  description: string,
  extraAttributes: Record<string, string>,
  pickupLocation: string | null,
  photos?: ListingPhoto[]
): DeepSearchDetail {
  const detail: DeepSearchDetail = {
    description,
    extraAttributes,
    questionsAndAnswers: [],
    pickupLocation,
  };
  if (photos) detail.photos = photos;
  return detail;
}

// ── Photo extraction ──────────────────────────────────────────────────────────
//
// Facebook tags each listing's own gallery images with a fixed, stable alt-text
// pattern: "Product photo of <title>" — everything else on the detail page
// (suggested-listing thumbnails, avatars, chat icons, loading placeholders) uses
// a different alt pattern or none at all, so this is far more reliable than
// filtering by image size or DOM position. Live-verified against 4 real
// listings. Facebook's CDN URLs are signed and don't expose a separate
// thumbnail/full-size pair the way TradeMe's photoserver URLs do, so the same
// URL is used for both in buildFacebookPhotosFromUrls below.
//
// Self-contained for the same reason as extractFacebookDetailsCardData — this
// is passed directly to page.evaluate().
export function extractFacebookPhotoUrls(): string[] {
  const urls = Array.from(document.querySelectorAll('img'))
    .filter((img) => img.alt?.startsWith('Product photo of '))
    .map((img) => img.src);
  return Array.from(new Set(urls));
}

export function buildFacebookPhotosFromUrls(urls: string[]): ListingPhoto[] | undefined {
  if (urls.length === 0) return undefined;
  return urls.map((url) => ({ thumbnailUrl: url, fullSizeUrl: url }));
}

export async function fetchFacebookListingDetailAsync(
  page: Page,
  url: string
): Promise<DeepSearchDetail> {
  console.log(`[facebook] fetching: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  if (await detectLoginWallAsync(page)) {
    throw new Error(LOGIN_REQUIRED_MESSAGE);
  }

  // Expand truncated description if "See more" is present
  const seeMoreBtn = page.getByRole('button', { name: 'See more' }).first();
  if (await seeMoreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await seeMoreBtn.click();
    await page.waitForTimeout(500);
  }

  const cardData = await page.evaluate(extractFacebookDetailsCardData);

  const extraAttributes = cardData?.attributePairs ?? {};
  // Facebook Marketplace has no auctions/reserves and no structured fulfillment
  // data — only pickupLocation has a real signal here, so that's all we add.
  const { description, pickupLocation } = cardData
    ? deriveFacebookDescriptionAndLocation(cardData.cardInnerText, cardData.attributeRowCount)
    : { description: '', pickupLocation: null };

  const photoUrls = await page.evaluate(extractFacebookPhotoUrls);
  const photos = buildFacebookPhotosFromUrls(photoUrls);

  return buildFacebookDeepSearchDetail(description, extraAttributes, pickupLocation, photos);
}

// ── Deep search ───────────────────────────────────────────────────────────────

async function deepSearchAsync(
  listings: Listing[],
  onEvent: (event: DeepSearchEvent) => void,
  isCancelled?: () => boolean
): Promise<void> {
  let browser: Browser | undefined;
  try {
    const browserSetup = await createContext();
    browser = browserSetup.browser;

    await Promise.all(
      listings.map((listing, listingIndex) =>
        enqueue(listing.url, async () => {
          const currentPage = await browserSetup.context.newPage();
          if (isCancelled?.()) {
            await currentPage.close();
            return;
          }
          await maskHeadless(currentPage);
          try {
            onEvent({
              type: 'progress',
              index: listingIndex + 1,
              total: listings.length,
              title: listing.title,
            });
            try {
              const detail = await fetchFacebookListingDetailAsync(currentPage, listing.url);
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
    await browser?.close();
  }
}

// ── Discover URL building ─────────────────────────────────────────────────────

const FACEBOOK_QUERY_SYSTEM_PROMPT =
  "You extract a concise Facebook Marketplace search query from a user's item description. " +
  'Return JSON: {"query":"<keywords>"}. ' +
  'Rules: 2–5 keywords maximum. ' +
  'Keep: product name, brand, model number. ' +
  'Remove: filler phrases ("I\'m looking for", "ideally", "preferably"), price, condition descriptions, delivery preferences, punctuation.';

export async function buildFacebookSearchQueryAsync(
  prompt: string,
  aiConfig: AiConfig
): Promise<string> {
  const result = applyAiJsonResult(
    aiConfig.cooldownStore,
    await aiJSON(aiConfig, 'facebook:query', FACEBOOK_QUERY_SYSTEM_PROMPT, prompt.trim(), 64)
  ) as Record<string, unknown> | null;
  if (typeof result?.query !== 'string' || !result.query.trim()) {
    throw new Error('facebook:query AI returned invalid query');
  }
  return result.query.trim();
}

const ITEM_CONDITION_PARAM_BY_CONDITION: Record<ListingCondition, string> = {
  used: 'used_like_new,used_good,used_fair',
  new: 'new',
};

export type BuildFacebookUrlOptions = {
  searchTerm: string;
  maxPrice: number;
  fulfillment: Fulfillment;
  regionValue: string | undefined;
  includeSoldItems: boolean;
  condition: ListingCondition;
  regions?: RegionEntry[];
};

export function buildFacebookUrl({
  searchTerm,
  maxPrice,
  fulfillment,
  regionValue,
  includeSoldItems,
  condition,
  regions = getRegions(),
}: BuildFacebookUrlOptions): string {
  const pickupOnly = !includeSoldItems && fulfillment === 'pickup' && !!regionValue;
  const fbParams = new URLSearchParams();
  fbParams.set('query', searchTerm);
  if (includeSoldItems) {
    fbParams.set('availability', 'out of stock');
  } else {
    if (maxPrice > 0) fbParams.set('maxPrice', String(maxPrice));
    if (fulfillment === 'pickup') fbParams.set('deliveryMethod', 'local_pick_up');
    else if (fulfillment === 'shipping') fbParams.set('deliveryMethod', 'shipping');
    fbParams.set('itemCondition', ITEM_CONDITION_PARAM_BY_CONDITION[condition]);
  }
  fbParams.set('exact', 'false');
  fbParams.set('sortBy', 'creation_time_descend');
  let fbLocationSegment = '';
  if (pickupOnly) {
    const region = regions.find((r) => String(r.tradeMeRegionId) === regionValue);
    if (region?.facebookLocation) fbLocationSegment = `${region.facebookLocation}/`;
  }
  return `https://www.facebook.com/marketplace/${fbLocationSegment}search?${fbParams.toString()}`;
}

async function buildDiscoverUrlsAsync(prompt: string, context: DiscoverContext) {
  const searchTerm = await buildFacebookSearchQueryAsync(prompt, context.getAiConfig());
  const urls = [
    buildFacebookUrl({
      searchTerm,
      maxPrice: context.maxPrice,
      fulfillment: context.fulfillment,
      regionValue: context.regionValue,
      includeSoldItems: false,
      condition: 'used',
    }),
  ];
  if (context.includeNewItems) {
    urls.push(
      buildFacebookUrl({
        searchTerm,
        maxPrice: context.maxPrice,
        fulfillment: context.fulfillment,
        regionValue: context.regionValue,
        includeSoldItems: false,
        condition: 'new',
      })
    );
  }
  if (context.includeSoldItems) {
    urls.push(
      buildFacebookUrl({
        searchTerm,
        maxPrice: context.maxPrice,
        fulfillment: context.fulfillment,
        regionValue: context.regionValue,
        includeSoldItems: true,
        condition: 'used',
      })
    );
  }
  return { urls, warnings: [] as string[] };
}

// ── Recipe ────────────────────────────────────────────────────────────────────

// Includes price, unlike TradeMe: Facebook Marketplace listings are
// fixed-price (no bidding), so price is stable for the same physical
// listing across runs. thumbnailUrl is deliberately NOT used here — it's a
// raw, unmodified img.src off Facebook's DOM, and Facebook CDN image URLs
// are commonly per-request signed with expiring tokens, which would make the
// same listing never match a previous alert.
function computeAlertFingerprint(listing: Listing): string {
  return hashFingerprintParts([
    listing.title,
    listing.location,
    listing.description,
    listing.price,
  ]);
}

export const facebookRecipe: DiscoverableRecipe = {
  name: FACEBOOK_PATTERN.name,
  matches(url: string): boolean {
    try {
      const { hostname, pathname } = new URL(url);
      return (
        hostname.endsWith(FACEBOOK_PATTERN.hostname) &&
        pathname.includes(FACEBOOK_PATTERN.pathPrefix)
      );
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
