export type ServerTabApi = {
  runtime: { getURL(path: string): string };
  tabs: {
    query(queryInfo: { url: string }): Promise<Array<{ id?: number; windowId: number }>>;
    update(tabId: number, properties: { active: boolean }): Promise<unknown>;
    create(properties: { url: string; pinned: boolean }): Promise<unknown>;
  };
  windows: { update(windowId: number, properties: { focused: boolean }): Promise<unknown> };
  action: { onClicked: { addListener(listener: () => void): void } };
};

const SERVER_TAB_PAGE = 'server.html';

async function openOrFocusServerTabAsync(chromeApi: ServerTabApi): Promise<void> {
  const url = chromeApi.runtime.getURL(SERVER_TAB_PAGE);
  const [existingTab] = await chromeApi.tabs.query({ url });

  if (existingTab?.id === undefined) {
    await chromeApi.tabs.create({ url, pinned: true });
    return;
  }
  await chromeApi.tabs.update(existingTab.id, { active: true });
  await chromeApi.windows.update(existingTab.windowId, { focused: true });
}

export function startServerTabButton(chromeApi: ServerTabApi): void {
  chromeApi.action.onClicked.addListener(() => {
    void openOrFocusServerTabAsync(chromeApi);
  });
}
