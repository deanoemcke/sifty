import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { launchCalls, closeCalls, makeBrowser } = vi.hoisted(() => {
  const launchCalls: string[] = [];
  const closeCalls: string[] = [];
  function makeBrowser(id: string, options: { connected?: boolean; contexts?: unknown[] } = {}) {
    const { connected = true, contexts = [] } = options;
    return {
      id,
      isConnected: () => connected,
      contexts: () => contexts,
      close: async () => {
        closeCalls.push(id);
      },
    };
  }
  return { launchCalls, closeCalls, makeBrowser };
});

let nextBrowser: ReturnType<typeof makeBrowser>;
let nextLaunchError: Error | undefined;

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
      if (nextLaunchError) {
        const err = nextLaunchError;
        nextLaunchError = undefined;
        launchCalls.push(`error:${err.message}`);
        throw err;
      }
      launchCalls.push(nextBrowser.id);
      return nextBrowser;
    },
  },
}));

import { getSharedBrowserAsync, MAX_USES_BEFORE_RECYCLE } from './browserPool';

describe('getSharedBrowserAsync', () => {
  beforeEach(() => {
    launchCalls.length = 0;
    closeCalls.length = 0;
    nextLaunchError = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('launches a browser on first use', async () => {
    nextBrowser = makeBrowser('a');

    const checkout = await getSharedBrowserAsync('facebook-test-1');

    expect(checkout.browser).toBe(nextBrowser);
    expect(launchCalls).toEqual(['a']);
  });

  it('reuses the same browser for the same key without relaunching', async () => {
    nextBrowser = makeBrowser('b');
    const key = 'facebook-test-2';

    const first = await getSharedBrowserAsync(key);
    first.releaseCheckout();
    const second = await getSharedBrowserAsync(key);

    expect(second.browser).toBe(first.browser);
    expect(launchCalls).toEqual(['b']);
  });

  it('launches independently for different keys', async () => {
    nextBrowser = makeBrowser('c');
    const first = await getSharedBrowserAsync('facebook-test-3');

    nextBrowser = makeBrowser('d');
    const second = await getSharedBrowserAsync('trademe-test-3');

    expect(first.browser).not.toBe(second.browser);
    expect(launchCalls).toEqual(['c', 'd']);
  });

  it('relaunches if the pooled browser has disconnected', async () => {
    const key = 'facebook-test-4';
    nextBrowser = makeBrowser('e', { connected: false });
    const first = await getSharedBrowserAsync(key);
    first.releaseCheckout();
    expect(first.browser.isConnected()).toBe(false);

    nextBrowser = makeBrowser('f', { connected: true });
    const second = await getSharedBrowserAsync(key);

    expect(second.browser).toBe(nextBrowser);
    expect(launchCalls).toEqual(['e', 'f']);
  });

  it('recycles the browser after MAX_USES_BEFORE_RECYCLE checkouts', async () => {
    const key = 'facebook-test-recycle';
    nextBrowser = makeBrowser('g');

    for (let i = 0; i < MAX_USES_BEFORE_RECYCLE; i++) {
      const checkout = await getSharedBrowserAsync(key);
      expect(checkout.browser).toBe(nextBrowser);
      checkout.releaseCheckout();
    }
    expect(launchCalls).toEqual(['g']);

    nextBrowser = makeBrowser('h');
    const recycled = await getSharedBrowserAsync(key);

    expect(recycled.browser).toBe(nextBrowser);
    expect(launchCalls).toEqual(['g', 'h']);
  });

  it('does not double-launch when two callers race at the recycle boundary', async () => {
    const key = 'facebook-test-concurrent-recycle';
    nextBrowser = makeBrowser('old');

    for (let i = 0; i < MAX_USES_BEFORE_RECYCLE; i++) {
      const checkout = await getSharedBrowserAsync(key);
      checkout.releaseCheckout();
    }
    expect(launchCalls).toEqual(['old']);

    // Both callers observe uses === MAX_USES_BEFORE_RECYCLE and race to
    // recycle at once. Without per-key serialization, both would launch a
    // fresh browser and only one survives in the pool — orphaning the other.
    nextBrowser = makeBrowser('new');
    const [first, second] = await Promise.all([
      getSharedBrowserAsync(key),
      getSharedBrowserAsync(key),
    ]);

    expect(first.browser).toBe(second.browser);
    expect(launchCalls).toEqual(['old', 'new']);
  });

  it('serializes concurrent first-use calls for a brand-new key to a single launch', async () => {
    const key = 'facebook-test-concurrent-first-use';
    nextBrowser = makeBrowser('first');

    const [first, second] = await Promise.all([
      getSharedBrowserAsync(key),
      getSharedBrowserAsync(key),
    ]);

    expect(first.browser).toBe(second.browser);
    expect(launchCalls).toEqual(['first']);
  });

  it('waits for a retiring browser’s open contexts to close before closing it', async () => {
    vi.useFakeTimers();
    const key = 'facebook-test-drain';
    const openContexts: unknown[] = [{}];
    nextBrowser = makeBrowser('old', { contexts: openContexts });

    for (let i = 0; i < MAX_USES_BEFORE_RECYCLE; i++) {
      const checkout = await getSharedBrowserAsync(key);
      checkout.releaseCheckout();
    }

    nextBrowser = makeBrowser('new');
    const recycled = await getSharedBrowserAsync(key);
    recycled.releaseCheckout();
    expect(recycled.browser).toBe(nextBrowser);

    // The old browser's context is still open — it must not be closed yet.
    await vi.advanceTimersByTimeAsync(2000);
    expect(closeCalls).not.toContain('old');

    // Once the caller closes its context, the next poll tick closes the browser.
    openContexts.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(closeCalls).toContain('old');
  });

  it('force-closes a retiring browser after the drain timeout even if contexts remain open', async () => {
    vi.useFakeTimers();
    const key = 'facebook-test-force-close';
    const stuckContexts: unknown[] = [{}];
    nextBrowser = makeBrowser('stuck', { contexts: stuckContexts });

    for (let i = 0; i < MAX_USES_BEFORE_RECYCLE; i++) {
      const checkout = await getSharedBrowserAsync(key);
      checkout.releaseCheckout();
    }

    nextBrowser = makeBrowser('fresh');
    const fresh = await getSharedBrowserAsync(key);
    fresh.releaseCheckout();

    // Mirrors browserPool's RETIRE_DRAIN_TIMEOUT_MS (5 minutes) — the context
    // deliberately never closes, so this exercises the force-close fallback.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2000);

    expect(closeCalls).toContain('stuck');
  });

  it('does not close a retiring browser while a checkout is still opening its context, even with zero open contexts', async () => {
    vi.useFakeTimers();
    const key = 'facebook-test-pending-checkout';
    nextBrowser = makeBrowser('old');

    // Leave one checkout short of the recycle boundary, so the next call
    // below is the one that pushes `uses` to MAX_USES_BEFORE_RECYCLE.
    for (let i = 0; i < MAX_USES_BEFORE_RECYCLE - 1; i++) {
      const checkout = await getSharedBrowserAsync(key);
      checkout.releaseCheckout();
    }

    // This checkout pushes the recycle boundary but deliberately never
    // releases its checkout, simulating a caller that is still in the
    // (synchronous-looking but actually suspendable) gap between receiving
    // the browser and finishing browser.newContext(...).
    const staleCheckout = await getSharedBrowserAsync(key);
    expect(staleCheckout.browser).toBe(nextBrowser);

    nextBrowser = makeBrowser('new');
    const recycled = await getSharedBrowserAsync(key);
    recycled.releaseCheckout();
    expect(recycled.browser).toBe(nextBrowser);

    // The old browser has zero open contexts (browser.contexts() length is
    // 0, since the caller hasn't created one yet) but still has a pending
    // checkout — retireBrowserAsync must not close it on that basis alone.
    expect(staleCheckout.browser.contexts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(closeCalls).not.toContain('old');

    // Once the caller finishes creating its context (or fails to) and
    // releases the checkout, the browser is free to close on the next poll.
    staleCheckout.releaseCheckout();
    await vi.advanceTimersByTimeAsync(1000);
    expect(closeCalls).toContain('old');
  });

  it('releaseCheckout is idempotent — a double-release does not cancel out a different pending checkout', async () => {
    vi.useFakeTimers();
    const key = 'facebook-test-double-release';
    nextBrowser = makeBrowser('old');

    // Leave two checkouts short of the boundary, so the next two calls below
    // are the ones that reach uses === MAX_USES_BEFORE_RECYCLE.
    for (let i = 0; i < MAX_USES_BEFORE_RECYCLE - 2; i++) {
      const checkout = await getSharedBrowserAsync(key);
      checkout.releaseCheckout();
    }

    const checkoutA = await getSharedBrowserAsync(key);
    const checkoutB = await getSharedBrowserAsync(key);
    expect(checkoutA.browser).toBe(nextBrowser);
    expect(checkoutB.browser).toBe(nextBrowser);

    // Without the idempotency guard, releasing A twice would decrement
    // pendingCheckouts by 2 — wrongly cancelling out B's still-pending
    // checkout and letting the browser close while B is mid-checkout.
    checkoutA.releaseCheckout();
    checkoutA.releaseCheckout();

    nextBrowser = makeBrowser('new');
    const recycled = await getSharedBrowserAsync(key);
    recycled.releaseCheckout();

    await vi.advanceTimersByTimeAsync(2000);
    expect(closeCalls).not.toContain('old');

    checkoutB.releaseCheckout();
    await vi.advanceTimersByTimeAsync(1000);
    expect(closeCalls).toContain('old');
  });

  it('does not permanently wedge a key after a launch failure — the next call retries', async () => {
    const key = 'facebook-test-launch-failure';
    nextLaunchError = new Error('transient resource shortage');

    await expect(getSharedBrowserAsync(key)).rejects.toThrow('transient resource shortage');

    nextBrowser = makeBrowser('recovered');
    const recovered = await getSharedBrowserAsync(key);

    expect(recovered.browser).toBe(nextBrowser);
    expect(launchCalls).toEqual(['error:transient resource shortage', 'recovered']);
  });

  it('retries on every failed launch attempt, not just once, until one succeeds', async () => {
    const key = 'facebook-test-launch-failure-repeated';

    nextLaunchError = new Error('first failure');
    await expect(getSharedBrowserAsync(key)).rejects.toThrow('first failure');

    nextLaunchError = new Error('second failure');
    await expect(getSharedBrowserAsync(key)).rejects.toThrow('second failure');

    nextBrowser = makeBrowser('finally-up');
    const recovered = await getSharedBrowserAsync(key);

    expect(recovered.browser).toBe(nextBrowser);
    expect(launchCalls).toEqual(['error:first failure', 'error:second failure', 'finally-up']);
  });
});
