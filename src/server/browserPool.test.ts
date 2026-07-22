import { beforeEach, describe, expect, it, vi } from 'vitest';

const { launchCalls, makeBrowser } = vi.hoisted(() => {
  const launchCalls: string[] = [];
  function makeBrowser(id: string, connected = true) {
    return {
      id,
      connected,
      isConnected: () => connected,
    };
  }
  return { launchCalls, makeBrowser };
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

import { getSharedBrowserAsync } from './browserPool';

describe('getSharedBrowserAsync', () => {
  beforeEach(() => {
    launchCalls.length = 0;
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
    nextBrowser = makeBrowser('e', false);
    const first = await getSharedBrowserAsync(key);
    expect(first.isConnected()).toBe(false);

    nextBrowser = makeBrowser('f', true);
    const second = await getSharedBrowserAsync(key);

    expect(second).toBe(nextBrowser);
    expect(launchCalls).toEqual(['e', 'f']);
  });
});
