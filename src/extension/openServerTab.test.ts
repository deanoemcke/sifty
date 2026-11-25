import { describe, expect, it, vi } from 'vitest';
import { type ServerTabApi, startServerTabButton } from './openServerTab';

const SERVER_TAB_URL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/server.html';

function makeFakeChrome(existingTabs: Array<{ id: number; windowId: number }>) {
  const clickListeners: Array<() => void> = [];
  const queryCalls: unknown[] = [];
  const updateTab = vi.fn(async () => {});
  const focusWindow = vi.fn(async () => {});
  const createTab = vi.fn(async () => {});

  const chromeApi: ServerTabApi = {
    runtime: { getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}` },
    tabs: {
      query: async (queryInfo) => {
        queryCalls.push(queryInfo);
        return existingTabs;
      },
      update: updateTab,
      create: createTab,
    },
    windows: { update: focusWindow },
    action: { onClicked: { addListener: (listener) => clickListeners.push(listener) } },
  };
  return { chromeApi, clickListeners, queryCalls, updateTab, focusWindow, createTab };
}

async function clickToolbarButton(fake: ReturnType<typeof makeFakeChrome>) {
  startServerTabButton(fake.chromeApi);
  fake.clickListeners[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('startServerTabButton', () => {
  it('opens a pinned Sifty Server tab when none is open', async () => {
    const fake = makeFakeChrome([]);

    await clickToolbarButton(fake);

    expect(fake.createTab).toHaveBeenCalledWith({ url: SERVER_TAB_URL, pinned: true });
    expect(fake.updateTab).not.toHaveBeenCalled();
  });

  it('looks for an existing tab by the extension page URL', async () => {
    const fake = makeFakeChrome([]);

    await clickToolbarButton(fake);

    expect(fake.queryCalls).toEqual([{ url: SERVER_TAB_URL }]);
  });

  it('brings the existing tab and its window to the front instead of opening another', async () => {
    const fake = makeFakeChrome([{ id: 7, windowId: 3 }]);

    await clickToolbarButton(fake);

    expect(fake.updateTab).toHaveBeenCalledWith(7, { active: true });
    expect(fake.focusWindow).toHaveBeenCalledWith(3, { focused: true });
    expect(fake.createTab).not.toHaveBeenCalled();
  });

  it('uses the first tab when several are open', async () => {
    const fake = makeFakeChrome([
      { id: 7, windowId: 3 },
      { id: 9, windowId: 4 },
    ]);

    await clickToolbarButton(fake);

    expect(fake.updateTab).toHaveBeenCalledTimes(1);
    expect(fake.updateTab).toHaveBeenCalledWith(7, { active: true });
  });
});
