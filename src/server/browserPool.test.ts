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

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('launches a browser on first use', async () => {
    nextBrowser = makeBrowser('a');

    const browser = await getSharedBrowserAsync('facebook-test-1');

    expect(browser).toBe(nextBrowser);
    expect(launchCalls).toEqual(['a']);
  });

  it('reuses the same browser for the same key without relaunching', async () => {
    nextBrowser = makeBrowser('b');
    const key = 'facebook-test-2';

    const first = await getSharedBrowserAsync(key);
    const second = await getSharedBrowserAsync(key);

    expect(second).toBe(first);
    expect(launchCalls).toEqual(['b']);
  });

  it('launches independently for different keys', async () => {
    nextBrowser = makeBrowser('c');
    const first = await getSharedBrowserAsync('facebook-test-3');

    nextBrowser = makeBrowser('d');
    const second = await getSharedBrowserAsync('trademe-test-3');

    expect(first).not.toBe(second);
    expect(launchCalls).toEqual(['c', 'd']);
  });

  it('relaunches if the pooled browser has disconnected', async () => {
    const key = 'facebook-test-4';
    nextBrowser = makeBrowser('e', { connected: false });
    const first = await getSharedBrowserAsync(key);
    expect(first.isConnected()).toBe(false);

    nextBrowser = makeBrowser('f', { connected: true });
    const second = await getSharedBrowserAsync(key);

    expect(second).toBe(nextBrowser);
    expect(launchCalls).toEqual(['e', 'f']);
  });

  it('recycles the browser after MAX_USES_BEFORE_RECYCLE checkouts', async () => {
    const key = 'facebook-test-recycle';
    nextBrowser = makeBrowser('g');

    for (let i = 0; i < MAX_USES_BEFORE_RECYCLE; i++) {
      const browser = await getSharedBrowserAsync(key);
      expect(browser).toBe(nextBrowser);
    }
    expect(launchCalls).toEqual(['g']);

    nextBrowser = makeBrowser('h');
    const recycled = await getSharedBrowserAsync(key);

    expect(recycled).toBe(nextBrowser);
    expect(launchCalls).toEqual(['g', 'h']);
  });

  it('waits for a retiring browser’s open contexts to close before closing it', async () => {
    vi.useFakeTimers();
    const key = 'facebook-test-drain';
    const openContexts: unknown[] = [{}];
    nextBrowser = makeBrowser('old', { contexts: openContexts });

    for (let i = 0; i < MAX_USES_BEFORE_RECYCLE; i++) {
      await getSharedBrowserAsync(key);
    }

    nextBrowser = makeBrowser('new');
    const recycled = await getSharedBrowserAsync(key);
    expect(recycled).toBe(nextBrowser);

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
      await getSharedBrowserAsync(key);
    }

    nextBrowser = makeBrowser('fresh');
    await getSharedBrowserAsync(key);

    // Mirrors browserPool's RETIRE_DRAIN_TIMEOUT_MS (5 minutes) — the context
    // deliberately never closes, so this exercises the force-close fallback.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2000);

    expect(closeCalls).toContain('stuck');
  });
});
