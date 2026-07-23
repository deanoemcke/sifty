import { type Browser, chromium } from 'playwright';

// Bounds how much memory a single long-lived Chromium process can accumulate
// (V8 heap fragmentation, disk/memory caches) over a server's uptime — deep
// search and quick search both funnel through this pool, so without a cap the
// same process would otherwise stay alive indefinitely.
export const MAX_USES_BEFORE_RECYCLE = 200;
// A retiring browser waits for its open contexts to close themselves (each
// caller closes its own context when done) rather than being yanked out from
// under an in-flight search. This caps how long that wait can run before
// force-closing anyway, in case a caller's context is never closed.
const RETIRE_DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
const RETIRE_POLL_INTERVAL_MS = 1000;

interface PoolEntry {
  browserPromise: Promise<Browser>;
  uses: number;
  // Reserved the instant a browser is handed out by getSharedBrowserAsync,
  // released once the caller has created its BrowserContext (or given up
  // after a failed attempt). This covers the gap between "browser returned"
  // and "context created", during which browser.contexts().length is still
  // 0 even though the browser is very much in use — see retireBrowserAsync.
  pendingCheckouts: number;
}

// Returned to callers of getSharedBrowserAsync instead of a bare Browser, so
// the pool can be told when a checkout has finished being turned into a
// BrowserContext (or failed to). Callers must call releaseCheckout exactly
// once — on success right after context creation, or on failure via a
// finally block — so a retiring browser knows this checkout is no longer
// pending. releaseCheckout is idempotent, safe to call more than once.
export interface BrowserCheckout {
  browser: Browser;
  releaseCheckout: () => void;
}

const pools = new Map<string, PoolEntry>();

// Serializes the check-then-act body below per key: without this, two
// concurrent callers for the same key could both observe the recycle
// threshold (or a disconnected browser) at once, both launch a fresh
// Chromium instance, and both call pools.set — only the last write survives
// in the map, orphaning the other freshly-launched browser process forever.
// Queuing acquisitions per key through this map removes that race; the
// queue is keyed by the same small, fixed set of recipe keys as `pools`, so
// it never grows unbounded.
const acquisitionQueues = new Map<string, Promise<unknown>>();

function reserveCheckout(browser: Browser, entry: PoolEntry): BrowserCheckout {
  entry.pendingCheckouts++;
  let released = false;
  return {
    browser,
    releaseCheckout: () => {
      if (released) return;
      released = true;
      entry.pendingCheckouts--;
    },
  };
}

async function retireBrowserAsync(browser: Browser, entry: PoolEntry): Promise<void> {
  const deadline = Date.now() + RETIRE_DRAIN_TIMEOUT_MS;
  while ((entry.pendingCheckouts > 0 || browser.contexts().length > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RETIRE_POLL_INTERVAL_MS));
  }
  const remainingContexts = browser.contexts().length;
  const remainingCheckouts = entry.pendingCheckouts;
  if (remainingContexts > 0 || remainingCheckouts > 0) {
    console.warn(
      `[browserPool] retiring browser still had ${remainingContexts} open context(s) and ` +
        `${remainingCheckouts} pending checkout(s) after ${RETIRE_DRAIN_TIMEOUT_MS}ms — closing anyway`
    );
  }
  await browser.close().catch(() => undefined);
}

// Deep search and quick search launch a browser per call by default, which
// single-listing modal opens pay in full just to view one page. This keeps one
// warm Chromium instance per keyed recipe (e.g. "facebook", "trademe") alive
// across calls, relaunching only if the previous instance crashed/disconnected
// or has served MAX_USES_BEFORE_RECYCLE contexts. Callers create their own
// BrowserContext per call and are responsible for closing it — this pool never
// closes an in-use browser itself, only a retired one, and only once its
// pending checkouts have all been released and its contexts have all closed
// (see retireBrowserAsync above). Callers MUST call the returned
// releaseCheckout() once their BrowserContext has been created — on success
// right after creation, or in a finally block if creation throws — otherwise
// a retiring browser waits needlessly for the drain timeout.
export async function getSharedBrowserAsync(key: string): Promise<BrowserCheckout> {
  const previousAcquisition = acquisitionQueues.get(key) ?? Promise.resolve();
  const nextAcquisition = previousAcquisition
    .catch(() => undefined)
    .then(() => acquireBrowserForKeyAsync(key));
  acquisitionQueues.set(key, nextAcquisition);
  return nextAcquisition;
}

async function acquireBrowserForKeyAsync(key: string): Promise<BrowserCheckout> {
  const existing = pools.get(key);
  if (existing) {
    const browser = await existing.browserPromise;
    if (browser.isConnected() && existing.uses < MAX_USES_BEFORE_RECYCLE) {
      existing.uses++;
      return reserveCheckout(browser, existing);
    }
    if (browser.isConnected()) void retireBrowserAsync(browser, existing);
  }
  const launched = chromium.launch({ headless: true });
  const entry: PoolEntry = { browserPromise: launched, uses: 1, pendingCheckouts: 0 };
  pools.set(key, entry);
  const browser = await launched.catch((err) => {
    // Don't let a failed launch wedge this key forever — the pool caches the
    // *pending promise*, not its resolved value, so a rejected launch would
    // otherwise stay rejected in `pools` forever and every subsequent call
    // for this key would re-await (and immediately re-throw from) the same
    // dead promise. Clear the entry so the next call gets a fresh launch
    // attempt instead. Guarded on identity in case this entry was already
    // replaced by the time the rejection is observed.
    if (pools.get(key) === entry) pools.delete(key);
    throw err;
  });
  return reserveCheckout(browser, entry);
}
