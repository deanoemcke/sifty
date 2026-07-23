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

async function retireBrowserAsync(browser: Browser): Promise<void> {
  const deadline = Date.now() + RETIRE_DRAIN_TIMEOUT_MS;
  while (browser.contexts().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RETIRE_POLL_INTERVAL_MS));
  }
  const remaining = browser.contexts().length;
  if (remaining > 0) {
    console.warn(
      `[browserPool] retiring browser still had ${remaining} open context(s) after ` +
        `${RETIRE_DRAIN_TIMEOUT_MS}ms — closing anyway`
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
// contexts have all closed (see retireBrowserAsync above).
export async function getSharedBrowserAsync(key: string): Promise<Browser> {
  const previousAcquisition = acquisitionQueues.get(key) ?? Promise.resolve();
  const nextAcquisition = previousAcquisition
    .catch(() => undefined)
    .then(() => acquireBrowserForKeyAsync(key));
  acquisitionQueues.set(key, nextAcquisition);
  return nextAcquisition;
}

async function acquireBrowserForKeyAsync(key: string): Promise<Browser> {
  const existing = pools.get(key);
  if (existing) {
    const browser = await existing.browserPromise;
    if (browser.isConnected() && existing.uses < MAX_USES_BEFORE_RECYCLE) {
      existing.uses++;
      return browser;
    }
    if (browser.isConnected()) void retireBrowserAsync(browser);
  }
  const launched = chromium.launch({ headless: true });
  pools.set(key, { browserPromise: launched, uses: 1 });
  return launched;
}
