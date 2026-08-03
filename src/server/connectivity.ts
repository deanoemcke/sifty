// Server-side only — a lightweight "is the network up at all" probe, used
// by scheduler.ts to skip a saved search's scrape loop entirely when the
// host machine is offline, rather than letting every one of its URLs fail
// independently with the identical cause after its own SCRAPE_TIMEOUT_MS.

export const CONNECTIVITY_CHECK_TIMEOUT_MS = 3_000;
const CONNECTIVITY_CHECK_URL = 'https://www.google.com';

// Reachability, not success, is what this checks — any response (including
// a non-2xx one) means the request reached the network, so only a thrown
// error (DNS failure, connection refused, our own abort on timeout) counts
// as offline.
export async function checkInternetConnectivityAsync(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTIVITY_CHECK_TIMEOUT_MS);
  try {
    await fetch(CONNECTIVITY_CHECK_URL, { method: 'HEAD', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
