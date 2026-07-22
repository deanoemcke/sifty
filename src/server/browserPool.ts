import { type Browser, chromium } from 'playwright';

const browserPromises = new Map<string, Promise<Browser>>();

// Deep search launches a browser per call by default, which single-listing
// modal opens pay in full just to view one page. This keeps one warm Chromium
// instance per keyed recipe (e.g. "facebook", "trademe") alive across calls,
// relaunching only if the previous instance crashed/disconnected. Callers
// create their own BrowserContext per call and are responsible for closing
// it — this pool never closes the browser itself.
export async function getSharedBrowserAsync(key: string): Promise<Browser> {
  const existing = browserPromises.get(key);
  if (existing) {
    const browser = await existing;
    if (browser.isConnected()) return browser;
  }
  const launched = chromium.launch({ headless: true });
  browserPromises.set(key, launched);
  return launched;
}
