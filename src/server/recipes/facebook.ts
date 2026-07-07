import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { enqueue } from "../../lib/queue";
import type {
  AiConfig,
  DeepSearchDetail,
  DeepSearchEvent,
  DiscoverableRecipe,
  DiscoverContext,
  Fulfillment,
  Listing,
  QuickSearchEvent,
} from "../../lib/recipes/base";
import { requirePattern } from "../../lib/recipes/metadata";
import { aiJSON } from "../ai";
import { getRegions } from "../services/regions";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FACEBOOK_BASE = "https://www.facebook.com";

const FACEBOOK_PATTERN = requirePattern("facebook");

// ── Implicit filter extraction ────────────────────────────────────────────────

export function extractImplicitFilters(urlStr: string): Array<[string, string]> {
  try {
    const url = new URL(urlStr);
    const filterRows: Array<[string, string]> = [];

    const query = url.searchParams.get("query");
    if (query) filterRows.push(["Search", query]);

    const minPrice = url.searchParams.get("minPrice");
    const maxPrice = url.searchParams.get("maxPrice");
    if (minPrice && maxPrice) filterRows.push(["Price", `$${minPrice} – $${maxPrice}`]);
    else if (minPrice) filterRows.push(["Min Price", `$${minPrice}`]);
    else if (maxPrice) filterRows.push(["Max Price", `$${maxPrice}`]);

    const condition = url.searchParams.get("itemCondition");
    if (condition) filterRows.push(["Condition", condition]);

    const daysSinceListed = url.searchParams.get("daysSinceListed");
    if (daysSinceListed) filterRows.push(["Listed within", `${daysSinceListed} days`]);

    const sortBy = url.searchParams.get("sortBy");
    if (sortBy) filterRows.push(["Sort", sortBy]);

    return filterRows;
  } catch {
    return [];
  }
}

// ── Browser context ───────────────────────────────────────────────────────────

async function createContext(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "en-NZ" });

  // FB_COOKIES: JSON array of cookies exported from your browser (e.g. via the
  // "Cookie Editor" extension — Export > Export as JSON).
  const cookiesJson = process.env.FB_COOKIES;
  if (cookiesJson) {
    try {
      const raw = JSON.parse(cookiesJson) as Array<Record<string, unknown>>;
      await context.addCookies(
        raw.map((cookie) => ({
          name: String(cookie.name),
          value: String(cookie.value),
          domain: String(cookie.domain ?? ".facebook.com"),
          path: String(cookie.path ?? "/"),
          secure: Boolean(cookie.secure),
          httpOnly: Boolean(cookie.httpOnly),
          sameSite: (["Strict", "Lax", "None"].includes(String(cookie.sameSite))
            ? cookie.sameSite
            : "Lax") as "Strict" | "Lax" | "None",
          ...(typeof cookie.expirationDate === "number"
            ? { expires: cookie.expirationDate }
            : typeof cookie.expires === "number"
              ? { expires: cookie.expires }
              : {}),
        })),
      );
      console.log(`[facebook] loaded ${raw.length} cookies from FB_COOKIES`);
    } catch (error) {
      console.log("[facebook] Failed to parse FB_COOKIES:", error);
    }
  }

  return { browser, context };
}

async function maskHeadless(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // @ts-expect-error
    if (!window.chrome) window.chrome = { runtime: {} };
  });
}

// ── Listing extraction via MutationObserver ───────────────────────────────────

export const PRICE_REGEX = /^(?:[A-Z]{0,3}\$)[\d,]+(?:\.\d{2})?$|^Free$/;

export function parseFacebookPriceValue(priceLine: string | undefined): number | null {
  if (priceLine === undefined) return null;
  if (priceLine === "Free") return 0;
  const match = priceLine.replace(/,/g, "").match(/[\d.]+/);
  if (!match) return null;
  const parsed = parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseFacebookPriceLines(innerText: string): {
  price: number | null;
  lines: string[];
} {
  const lines = innerText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const priceLines = lines.filter((line) => PRICE_REGEX.test(line));
  const price = parseFacebookPriceValue(priceLines[0]);
  return { price, lines };
}

export function buildFacebookListing(
  url: string,
  thumbnailUrl: string | undefined,
  title: string,
  price: number | null,
  location: string,
): Listing {
  return {
    source: FACEBOOK_PATTERN.name,
    title,
    price,
    location,
    url,
    thumbnailUrl,
    isAuction: false,
  };
}

// Called from browser-side MutationObserver via page.exposeFunction.
// Runs in Node.js; returns void (browser side fire-and-forgets).
type RawListingMsg = {
  id: string;
  url: string;
  ariaLabel: string;
  innerText: string;
  thumbnailUrl: string;
};

function processRawListing(
  raw: RawListingMsg,
  seen: Set<string>,
  onEvent: (event: QuickSearchEvent) => void,
  counter: { total: number },
): void {
  if (seen.has(raw.id)) return;
  seen.add(raw.id);

  const { price, lines: innerLines } = parseFacebookPriceLines(raw.innerText);

  let title = "",
    location = "Unknown";
  const ariaLabel = raw.ariaLabel.replace(/,\s*listing\s+\d+\s*$/i, "").trim();
  const labelMatch = ariaLabel.match(/^(.+?),\s*(?:[A-Z]{0,3}\$[\d,]+(?:\.\d{2})?|Free),\s*(.+)$/);
  if (labelMatch) {
    title = labelMatch[1].trim();
    location = labelMatch[2].trim();
  }
  if (!title) {
    location = innerLines[innerLines.length - 1] ?? "Unknown";
    title = innerLines.find((line) => !PRICE_REGEX.test(line) && line !== location) ?? "";
  }
  if (!title) return;

  counter.total++;
  onEvent({
    type: "listing",
    data: buildFacebookListing(raw.url, raw.thumbnailUrl || undefined, title, price, location),
  });
}

// ── Quick search ──────────────────────────────────────────────────────────────

async function quickSearchAsync(
  searchUrl: string,
  onEvent: (event: QuickSearchEvent) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  onEvent({ type: "criteria", filters: extractImplicitFilters(searchUrl) });

  let browser: Browser | undefined;
  try {
    const browserSetup = await createContext();
    browser = browserSetup.browser;
    const page = await browserSetup.context.newPage();
    await maskHeadless(page);

    const seen = new Set<string>();
    const counter = { total: 0 };

    // Bridge: browser → Node.js. Called by the MutationObserver for every new listing link.
    await page.exposeFunction("fbListingFound", (raw: RawListingMsg) => {
      processRawListing(raw, seen, onEvent, counter);
    });

    onEvent({ type: "progress", phase: "loading" });
    console.log(`[facebook] fetching: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(`[facebook] loaded — url: ${page.url()}`);

    // Dismiss cookie consent if present
    const cookieBtn = page.locator(
      '[aria-label="Allow all cookies"], [title="Allow all cookies"], [data-cookiebanner="accept_button"]',
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

    // Wait for listings to render, or detect a login/block state
    const listingsAppeared = await page
      .waitForSelector('a[href*="/marketplace/item/"]', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    console.log(`[facebook] listingsAppeared: ${listingsAppeared} — url: ${page.url()}`);

    if (!listingsAppeared) {
      const snippet = await page
        .evaluate(() => document.body.innerText)
        .catch(() => "")
        .then((t) => t.slice(0, 300));
      console.log(`[facebook] page text snippet:\n${snippet}`);
      const isLoginWall =
        page.url().includes("/login") ||
        snippet.toLowerCase().includes("log in") ||
        snippet.toLowerCase().includes("sign up");
      onEvent({
        type: "error",
        message: isLoginWall
          ? "Facebook requires login. Set FB_COOKIES environment variable."
          : "No listings found. Facebook may be blocking access or the search returned no results.",
      });
      return;
    }

    // Inject MutationObserver — captures every listing link the moment it enters the DOM,
    // before virtualisation can remove it. Also processes all already-rendered links.
    await page.evaluate((base: string) => {
      function processLink(link: Element) {
        const href = link.getAttribute("href") ?? "";
        const match = href.match(/\/marketplace\/item\/(\d+)\//);
        if (!match) return;
        const img = link.querySelector("img");
        // biome-ignore lint/suspicious/noExplicitAny: Playwright-evaluated script; window is the browser's window, not typed
        (window as any).fbListingFound({
          id: match[1],
          url: `${base}/marketplace/item/${match[1]}/`,
          ariaLabel: link.getAttribute("aria-label") ?? "",
          innerText: (link as HTMLElement).innerText ?? "",
          thumbnailUrl: img ? (img as HTMLImageElement).src : "",
        });
      }

      document.querySelectorAll('a[href*="/marketplace/item/"]').forEach(processLink);

      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            const addedElement = node as Element;
            if (addedElement.matches('a[href*="/marketplace/item/"]')) processLink(addedElement);
            addedElement.querySelectorAll('a[href*="/marketplace/item/"]').forEach(processLink);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }, FACEBOOK_BASE);

    console.log(`[facebook] observer injected — initial: ${counter.total} listings`);
    if (counter.total > 0)
      onEvent({
        type: "progress",
        phase: "collecting",
        foundSoFar: counter.total,
        isLoadingMore: false,
      });

    // The login wall modal is present in the DOM from page load — check immediately after
    // the observer fires so we can skip the scroll loop and report the partial results.
    const loginWallDetected = await page
      .evaluate(() => {
        return (
          !!document.getElementById("login_popup_cta_form") ||
          !!document.querySelector('form[action*="/login/device-based/"]') ||
          !!document.querySelector('input[name="email"]') ||
          !!document.querySelector('input[name="pass"]')
        );
      })
      .catch(() => false);

    console.log(`[facebook] loginWallDetected: ${loginWallDetected}`);

    if (loginWallDetected) {
      console.log(`[facebook] login wall detected — only ${counter.total} listings available`);
      onEvent({
        type: "error",
        message: `Login wall detected — only ${counter.total} listing${counter.total !== 1 ? "s" : ""} loaded. Set the FB_COOKIES environment variable to get full results.`,
      });
      return;
    }

    // Scroll loop — just drives scrolling; extraction is handled by the observer above
    let noNewCount = 0;
    let lastTotal = 0;
    for (;;) {
      if (isCancelled?.()) break;
      const bodyText: string = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes("Results from outside your search")) break;

      // Simulate real scroll events — window.scrollTo alone doesn't trigger FB's
      // infinite scroll listener; mouse wheel + End key are more reliable.
      await page.mouse.wheel(0, 3000);
      await page.keyboard.press("End");
      await page.waitForTimeout(1500);

      if (counter.total > lastTotal) {
        onEvent({
          type: "progress",
          phase: "collecting",
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
    onEvent({ type: "complete" });
  } catch (error) {
    console.log(`[facebook] error:`, error);
    onEvent({ type: "error", message: (error as Error).message });
  } finally {
    await browser?.close();
  }
}

// ── Detail extraction ─────────────────────────────────────────────────────────

export function extractFacebookDescription(bodyText: string): string {
  // Description sits after the Details section's key-value pairs and before "See more"
  const detailsIdx = bodyText.indexOf("\nDetails\n");
  if (detailsIdx === -1) return "";
  const afterDetails = bodyText.slice(detailsIdx + "\nDetails\n".length);

  let end = afterDetails.length;
  const seeMoreIdx = afterDetails.indexOf("\nSee more\n");
  if (seeMoreIdx !== -1) end = Math.min(end, seeMoreIdx);
  const approxIdx = afterDetails.search(/\n.+·\s*Location is approximate/);
  if (approxIdx !== -1) end = Math.min(end, approxIdx);

  const lines = afterDetails
    .slice(0, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Skip leading detail key-value pairs (short lines, no sentence-ending punctuation)
  let lineIndex = 0;
  while (
    lineIndex < lines.length &&
    lines[lineIndex].length < 30 &&
    !/[.!?]/.test(lines[lineIndex])
  )
    lineIndex++;

  return lines.slice(lineIndex).join("\n").trim();
}

export function extractFacebookDetails(bodyText: string): Array<{ key: string; value: string }> {
  const details: Array<{ key: string; value: string }> = [];
  const detailsIdx = bodyText.indexOf("\nDetails\n");
  if (detailsIdx === -1) return [];

  const lines = bodyText
    .slice(detailsIdx + "\nDetails\n".length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let lineIndex = 0;
  while (lineIndex + 1 < lines.length) {
    const key = lines[lineIndex];
    const currentValue = lines[lineIndex + 1];
    // A detail pair: key is short/simple, value is short/simple (not prose)
    if (
      key.length < 30 &&
      !/[.!?]/.test(key) &&
      currentValue.length < 60 &&
      !/[.!?]{2}/.test(currentValue)
    ) {
      details.push({ key, value: currentValue });
      lineIndex += 2;
    } else {
      break;
    }
  }

  return details;
}

export function buildFacebookDeepSearchDetail(
  description: string,
  extraAttributes: Record<string, string>,
  pickupLocation: string | null,
): DeepSearchDetail {
  return { description, extraAttributes, questionsAndAnswers: [], pickupLocation };
}

async function fetchFacebookListingDetailAsync(page: Page, url: string): Promise<DeepSearchDetail> {
  console.log(`[facebook] fetching: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Expand truncated description if "See more" is present
  const seeMoreBtn = page.getByRole("button", { name: "See more" }).first();
  if (await seeMoreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await seeMoreBtn.click();
    await page.waitForTimeout(500);
  }

  const bodyText: string = await page.evaluate(() => document.body.innerText);

  const extraAttributes: Record<string, string> = {};
  for (const { key, value } of extractFacebookDetails(bodyText)) extraAttributes[key] = value;

  // Facebook Marketplace has no auctions/reserves and no structured fulfillment
  // data — only pickupLocation has a real signal here, so that's all we add.
  const locationMatch = bodyText.match(/Listed in ([^\n·]+)/);
  const pickupLocation = locationMatch?.[1]?.trim() ?? null;

  const description = extractFacebookDescription(bodyText);

  return buildFacebookDeepSearchDetail(description, extraAttributes, pickupLocation);
}

// ── Deep search ───────────────────────────────────────────────────────────────

async function deepSearchAsync(
  listings: Listing[],
  onEvent: (event: DeepSearchEvent) => void,
  isCancelled?: () => boolean,
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
              type: "progress",
              index: listingIndex + 1,
              total: listings.length,
              title: listing.title,
            });
            const detail = await fetchFacebookListingDetailAsync(currentPage, listing.url);
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
    await browser?.close();
  }
}

// ── Discover URL building ─────────────────────────────────────────────────────

const FACEBOOK_QUERY_SYSTEM_PROMPT =
  "You extract a concise Facebook Marketplace search query from a user's item description. " +
  'Return JSON: {"query":"<keywords>"}. ' +
  "Rules: 2–5 keywords maximum. " +
  "Keep: product name, brand, model number. " +
  'Remove: filler phrases ("I\'m looking for", "ideally", "preferably"), price, condition descriptions, delivery preferences, punctuation.';

export async function buildFacebookSearchQueryAsync(
  prompt: string,
  aiConfig: AiConfig,
): Promise<string> {
  const result = (await aiJSON(
    aiConfig,
    "facebook:query",
    FACEBOOK_QUERY_SYSTEM_PROMPT,
    prompt.trim(),
    64,
  )) as Record<string, unknown> | null;
  if (typeof result?.query !== "string" || !result.query.trim()) {
    throw new Error("facebook:query AI returned invalid query");
  }
  return result.query.trim();
}

export function buildFacebookUrl(
  searchTerm: string,
  maxPrice: number,
  fulfillment: Fulfillment,
  regionValue: string | undefined,
  regions = getRegions(),
): string {
  const pickupOnly = fulfillment === "pickup" && !!regionValue;
  const fbParams = new URLSearchParams();
  fbParams.set("query", searchTerm);
  if (maxPrice > 0) fbParams.set("maxPrice", String(maxPrice));
  if (fulfillment === "pickup") fbParams.set("deliveryMethod", "local_pick_up");
  else if (fulfillment === "shipping") fbParams.set("deliveryMethod", "shipping");
  fbParams.set("exact", "false");
  fbParams.set("sortBy", "creation_time_descend");
  let fbLocationSegment = "";
  if (pickupOnly) {
    const region = regions.find((r) => String(r.tradeMeRegionId) === regionValue);
    if (region?.facebookLocation) fbLocationSegment = `${region.facebookLocation}/`;
  }
  return `https://www.facebook.com/marketplace/${fbLocationSegment}search?${fbParams.toString()}`;
}

async function buildDiscoverUrlsAsync(prompt: string, context: DiscoverContext) {
  const searchTerm = await buildFacebookSearchQueryAsync(prompt, context.aiConfig);
  return {
    urls: [
      buildFacebookUrl(searchTerm, context.maxPrice, context.fulfillment, context.regionValue),
    ],
    warnings: [] as string[],
  };
}

// ── Recipe ────────────────────────────────────────────────────────────────────

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
};
