// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_HOST_NAME } from '../../nativeHost/hostName';
import type { BrowserCookie } from '../cookieSync';
import type { ChromeApi } from '../startCookieSync';
import { startServerTab } from './startServerTab';

const NOW_MS = Date.parse('2026-11-25T00:00:00Z');
const HOUR_MS = 60 * 60_000;

type HostRequest = { type: string; [field: string]: unknown };

const DEFAULT_REPLIES: Record<string, unknown> = {
  getStatus: {
    ok: true,
    cookies: {
      isSynced: true,
      isLoginUsable: true,
      syncedAtMs: NOW_MS - 2 * 60_000,
      cookieCount: 10,
      loginExpiryMs: NOW_MS + 81 * 24 * HOUR_MS,
    },
    settings: { targetIntervalMinutes: 240, maxSearchesPerTick: 5 },
  },
  getRunHistory: {
    ok: true,
    searches: [
      {
        id: 'search-1',
        name: 'Gravitrax',
        lastRunAtMs: NOW_MS - 3 * HOUR_MS,
        lastRunSucceeded: true,
        lastRunDetailLines: [],
        nextDueAtMs: NOW_MS + HOUR_MS,
      },
    ],
  },
  getServices: {
    ok: true,
    servicesByName: {
      webapp: {
        isInstalled: true,
        isIntervalJob: false,
        isLoaded: true,
        isRunning: true,
        isEnabled: true,
        pid: 4242,
      },
      ngrok: {
        isInstalled: false,
        isIntervalJob: false,
        isLoaded: false,
        isRunning: false,
        isEnabled: true,
        pid: null,
      },
      scheduler: {
        isInstalled: true,
        isIntervalJob: true,
        isLoaded: false,
        isRunning: false,
        isEnabled: false,
        pid: null,
      },
    },
  },
};

type LogTailContent = { isLogFilePresent: boolean; logLines: string[] };

const DEFAULT_LOG_TAILS_BY_LOG_NAME: Record<string, LogTailContent> = {
  scheduler: { isLogFilePresent: true, logLines: [] },
  'scheduler-launchd': { isLogFilePresent: true, logLines: [] },
  webapp: { isLogFilePresent: true, logLines: [] },
  ngrok: { isLogFilePresent: true, logLines: [] },
  'native-host': { isLogFilePresent: true, logLines: ['first line', 'second line'] },
};

function logTailMessage(logName: string, content: LogTailContent) {
  return { ok: true, event: 'logTail', logName, ...content };
}

function makeFakePort(logTailsByLogName: Record<string, LogTailContent>) {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const port = {
    postedMessages: [] as unknown[],
    isDisconnected: false,
    postMessage(message: unknown) {
      port.postedMessages.push(message);
      if ((message as HostRequest).type !== 'subscribeLogs') return;
      port.pushFromHost({ ok: true, isSubscribed: true });
      for (const [logName, content] of Object.entries(logTailsByLogName)) {
        port.pushFromHost(logTailMessage(logName, content));
      }
    },
    onMessage: {
      addListener: (listener: (message: unknown) => void) => messageListeners.push(listener),
    },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    disconnect() {
      port.isDisconnected = true;
    },
    pushFromHost(message: unknown) {
      for (const listener of messageListeners) listener(message);
    },
    closeFromHost() {
      port.isDisconnected = true;
      for (const listener of disconnectListeners) listener();
    },
  };
  return port;
}

type FakePort = ReturnType<typeof makeFakePort>;

function makeFakeChrome(
  options: {
    replies?: Record<string, unknown | ((request: HostRequest) => unknown)>;
    logTails?: Record<string, LogTailContent>;
    hostUnreachableError?: Error;
    browserCookies?: BrowserCookie[];
  } = {}
) {
  const replies = { ...DEFAULT_REPLIES, ...options.replies };
  const requests: HostRequest[] = [];
  const ports: FakePort[] = [];
  async function answerRequestAsync(request: HostRequest): Promise<unknown> {
    requests.push(request);
    const reply = replies[request.type];
    return typeof reply === 'function' ? reply(request) : reply;
  }
  const sendNativeMessage = vi.fn(async (_hostName: string, message: unknown) => {
    if (options.hostUnreachableError) throw options.hostUnreachableError;
    const request = message as HostRequest;
    if (request.type !== 'batch') return answerRequestAsync(request);
    const subRequests = request.requests as HostRequest[];
    return { ok: true, replies: await Promise.all(subRequests.map(answerRequestAsync)) };
  });
  const connectNative = vi.fn((_hostName: string) => {
    const port = makeFakePort(options.logTails ?? DEFAULT_LOG_TAILS_BY_LOG_NAME);
    ports.push(port);
    if (options.hostUnreachableError) queueMicrotask(() => port.closeFromHost());
    return port;
  });

  const chromeApi: ChromeApi = {
    cookies: {
      getAll: async () => options.browserCookies ?? [],
      onChanged: { addListener: () => {} },
    },
    runtime: {
      sendNativeMessage,
      connectNative,
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };
  return { chromeApi, requests, sendNativeMessage, connectNative, ports };
}

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app') as HTMLElement;
});

afterEach(() => {
  vi.useRealTimers();
  setPageHidden(false);
});

function setPageHidden(isHidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
}

function holdReply<Reply>() {
  let release: (reply: Reply) => void = () => {};
  const reply = new Promise<Reply>((resolve) => {
    release = resolve;
  });
  return { reply, release };
}

function sectionText(sectionName: string): string {
  return root.querySelector(`[data-section="${sectionName}"]`)?.textContent ?? '';
}

async function openTab(fake = makeFakeChrome(), nowMs: () => number = () => NOW_MS) {
  await startServerTab(root, {
    chromeApi: fake.chromeApi,
    nowMs,
    pollIntervalMs: 30_000,
  });
  return fake;
}

describe('startServerTab — loading', () => {
  it('shows the Facebook cookie health from the host', async () => {
    await openTab();

    expect(sectionText('cookies')).toContain('Facebook cookies synced');
    expect(sectionText('cookies')).toContain('Synced 2 minutes ago · 10 cookies');
  });

  it('lists each saved search with when it last ran and when it is next due', async () => {
    await openTab();

    expect(sectionText('runs')).toContain('Gravitrax');
    expect(sectionText('runs')).toContain('3 hours ago');
    expect(sectionText('runs')).toContain('Due in 1 hour');
  });

  it('shows failure lines for a failed search', async () => {
    const fake = makeFakeChrome({
      replies: {
        getRunHistory: {
          ok: true,
          searches: [
            {
              id: 'search-1',
              name: 'Broken search',
              lastRunAtMs: NOW_MS - HOUR_MS,
              lastRunSucceeded: false,
              lastRunDetailLines: ['scrape:Timed out'],
              nextDueAtMs: NOW_MS + HOUR_MS,
            },
          ],
        },
      },
    });
    await openTab(fake);

    expect(sectionText('runs')).toContain('scrape:Timed out');
  });

  it('shows saved-search names and log text as text, never as markup', async () => {
    const fake = makeFakeChrome({
      replies: {
        getRunHistory: {
          ok: true,
          searches: [
            {
              id: 'search-1',
              name: '<img src=x onerror="alert(1)">',
              lastRunAtMs: null,
              lastRunSucceeded: null,
              lastRunDetailLines: [],
              nextDueAtMs: null,
            },
          ],
        },
      },
    });
    await openTab(fake);

    expect(root.querySelector('img')).toBeNull();
    expect(sectionText('runs')).toContain('<img src=x onerror="alert(1)">');
  });

  it('says how to install the host when it cannot be reached, instead of showing empty sections', async () => {
    await openTab(
      makeFakeChrome({
        hostUnreachableError: new Error('Specified native messaging host not found.'),
      })
    );

    const banner = root.querySelector('[data-section="host-error"]')?.textContent ?? '';
    expect(banner).toContain('Specified native messaging host not found.');
    expect(banner).toContain('npm run native-host:install');
  });

  it('shows the host error when it answers with a failure', async () => {
    await openTab(
      makeFakeChrome({ replies: { getStatus: { ok: false, error: 'database is locked' } } })
    );

    expect(root.querySelector('[data-section="host-error"]')?.textContent).toContain(
      'database is locked'
    );
  });

  it('still shows the other panels and the settings form when one request fails', async () => {
    await openTab(
      makeFakeChrome({
        replies: { getServices: { ok: false, error: 'launchctl print-disabled failed (exit 1)' } },
      })
    );

    expect(sectionText('host-error')).toContain('launchctl print-disabled failed');
    expect(sectionText('cookies')).toContain('Facebook cookies synced');
    expect(sectionText('runs')).toContain('Gravitrax');
    expect(sectionText('logs')).toContain('first line');
    expect(settingsInput('targetIntervalMinutes').value).toBe('240');
  });

  it('reports every failed request and names the panels that were not updated', async () => {
    await openTab(
      makeFakeChrome({
        replies: {
          getServices: { ok: false, error: 'launchctl print-disabled failed (exit 1)' },
          getRunHistory: { ok: false, error: 'cannot read run history' },
        },
      })
    );

    const banner = sectionText('host-error');
    expect(banner).toContain('launchctl print-disabled failed');
    expect(banner).toContain('cannot read run history');
    expect(banner).toContain('Not updated: Services, Last runs');
    expect(banner).not.toContain('Cookies and settings');
  });

  it('names a panel as not updated when a later refresh fails and its old content stays', async () => {
    let isServicesRequestFailing = false;
    await openTab(
      makeFakeChrome({
        replies: {
          getServices: (): unknown => {
            if (isServicesRequestFailing) return { ok: false, error: 'launchctl hung' };
            return DEFAULT_REPLIES.getServices;
          },
        },
      })
    );
    expect(sectionText('host-error')).toBe('');

    isServicesRequestFailing = true;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sectionText('services')).toContain('webapp');
    expect(sectionText('host-error')).toContain('Not updated: Services');
  });
});

function settingsInput(settingName: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>(
    `[data-section="settings"] input[name="${settingName}"]`
  );
  if (!input) throw new Error(`No input named ${settingName}`);
  return input;
}

async function submitSettings(): Promise<void> {
  const form = root.querySelector<HTMLFormElement>('[data-section="settings"] form');
  if (!form) throw new Error('No settings form');
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
}

describe('startServerTab — scheduler settings', () => {
  it('pre-fills the form with the current settings', async () => {
    await openTab();

    expect(settingsInput('targetIntervalMinutes').value).toBe('240');
    expect(settingsInput('maxSearchesPerTick').value).toBe('5');
  });

  it('sends valid changes to the host as numbers and confirms the save', async () => {
    const fake = await openTab(
      makeFakeChrome({
        replies: {
          updateSettings: {
            ok: true,
            settings: { targetIntervalMinutes: 60, maxSearchesPerTick: 3 },
          },
        },
      })
    );

    settingsInput('targetIntervalMinutes').value = '60';
    settingsInput('maxSearchesPerTick').value = '3';
    await submitSettings();

    expect(fake.requests).toContainEqual({
      type: 'updateSettings',
      changes: { targetIntervalMinutes: 60, maxSearchesPerTick: 3 },
    });
    expect(sectionText('settings')).toContain('Saved');
  });

  it('shows an inline error and sends nothing when a value is out of range', async () => {
    const fake = await openTab();

    settingsInput('maxSearchesPerTick').value = '51';
    await submitSettings();

    expect(sectionText('settings')).toContain('Enter a whole number from 1 to 50');
    expect(fake.requests.some((request) => request.type === 'updateSettings')).toBe(false);
  });

  it('shows the host message and keeps what was typed when the host rejects the save', async () => {
    await openTab(
      makeFakeChrome({ replies: { updateSettings: { ok: false, error: 'database is locked' } } })
    );

    settingsInput('targetIntervalMinutes').value = '60';
    await submitSettings();

    expect(sectionText('settings')).toContain('database is locked');
    expect(settingsInput('targetIntervalMinutes').value).toBe('60');
  });
});

const LOGGED_IN_COOKIE: BrowserCookie = {
  name: 'xs',
  value: 'session',
  domain: '.facebook.com',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'no_restriction',
  hostOnly: false,
  session: false,
  storeId: '0',
  expirationDate: 1_900_000_000,
};

async function click(selector: string): Promise<void> {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Nothing matches ${selector}`);
  element.click();
  await vi.advanceTimersByTimeAsync(0);
}

describe('startServerTab — Sync now', () => {
  it('syncs the browser cookies to the host, says so, and refreshes the cookie health', async () => {
    const fake = makeFakeChrome({
      browserCookies: [LOGGED_IN_COOKIE],
      replies: { syncCookies: { ok: true, cookies: { isSynced: true } } },
    });
    await openTab(fake);
    const statusRequestsBefore = fake.requests.filter((r) => r.type === 'getStatus').length;

    await click('[data-section="cookies"] button');

    expect(fake.requests.some((request) => request.type === 'syncCookies')).toBe(true);
    expect(sectionText('cookies')).toContain('Cookie sync succeeded: sent 1 Facebook cookies');
    expect(fake.requests.filter((r) => r.type === 'getStatus').length).toBe(
      statusRequestsBefore + 1
    );
  });

  it('explains when Chrome has no Facebook cookies to sync', async () => {
    await openTab(makeFakeChrome({ browserCookies: [] }));

    await click('[data-section="cookies"] button');

    expect(sectionText('cookies')).toContain('no Facebook cookies');
  });

  it('drops the sync message once it is old, so a failure does not outlive its cause', async () => {
    let clockMs = NOW_MS;
    const fake = makeFakeChrome({
      browserCookies: [LOGGED_IN_COOKIE],
      replies: { syncCookies: { ok: false, error: 'host unreachable' } },
    });
    await openTab(fake, () => clockMs);
    await click('[data-section="cookies"] button');
    expect(sectionText('cookies')).toContain('Cookie sync rejected');

    await vi.advanceTimersByTimeAsync(30_000);
    clockMs += 30_000;
    expect(sectionText('cookies')).toContain('Cookie sync rejected');

    clockMs += 5 * 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sectionText('cookies')).not.toContain('Cookie sync rejected');
  });
});

describe('startServerTab — refreshing', () => {
  it('fetches every panel with one host request per refresh', async () => {
    const fake = await openTab();
    expect(fake.sendNativeMessage).toHaveBeenCalledTimes(1);
    expect(fake.sendNativeMessage.mock.calls[0][1]).toMatchObject({ type: 'batch' });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fake.sendNativeMessage).toHaveBeenCalledTimes(2);
  });

  it('refreshes status and run history on a timer without touching what is typed in the form', async () => {
    const fake = await openTab();
    settingsInput('targetIntervalMinutes').value = '75';

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fake.requests.filter((request) => request.type === 'getStatus')).toHaveLength(2);
    expect(fake.requests.filter((request) => request.type === 'getRunHistory')).toHaveLength(2);
    expect(settingsInput('targetIntervalMinutes').value).toBe('75');
  });

  it('does not poll while the page is hidden, and refreshes once when it is shown again', async () => {
    const fake = await openTab();
    const requestsAfterOpen = fake.requests.length;

    setPageHidden(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.requests).toHaveLength(requestsAfterOpen);

    setPageHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.requests.length).toBeGreaterThan(requestsAfterOpen);
  });

  it('shows the host error when a refresh fails, and recovers when the host comes back', async () => {
    let isHostUp = true;
    const fake = makeFakeChrome({
      replies: {
        getStatus: (): unknown => {
          if (!isHostUp) throw new Error('host exited');
          return DEFAULT_REPLIES.getStatus;
        },
      },
    });
    await openTab(fake);

    isHostUp = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector('[data-section="host-error"]')?.textContent).toContain('host exited');

    isHostUp = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector<HTMLElement>('[data-section="host-error"]')?.hidden).toBe(true);
  });
});

describe('startServerTab — refreshing while a refresh is already running', () => {
  it('shows the state after a service action even when a poll was already in flight', async () => {
    let isWebappRunning = true;
    const heldTail = holdReply<unknown>();
    let shouldHoldTail = false;
    const fake = makeFakeChrome({
      replies: {
        getRunHistory: () => (shouldHoldTail ? heldTail.reply : DEFAULT_REPLIES.getRunHistory),
        getServices: () => ({
          ok: true,
          servicesByName: {
            webapp: {
              isInstalled: true,
              isIntervalJob: false,
              isLoaded: isWebappRunning,
              isRunning: isWebappRunning,
              isEnabled: isWebappRunning,
              pid: isWebappRunning ? 4242 : null,
            },
          },
        }),
        controlService: () => {
          isWebappRunning = false;
          return { ok: true, serviceName: 'webapp', state: {} };
        },
      },
    });
    await openTab(fake);
    shouldHoldTail = true;
    await vi.advanceTimersByTimeAsync(30_000);

    await click('[data-service="webapp"] button[data-action="stop"]');
    shouldHoldTail = false;
    heldTail.release(DEFAULT_REPLIES.getRunHistory);
    await vi.advanceTimersByTimeAsync(0);

    expect(serviceRow('webapp').textContent).toContain('Off');
  });
});

describe('startServerTab — logs', () => {
  function logSelect(): HTMLSelectElement {
    const select = root.querySelector<HTMLSelectElement>('[data-section="logs"] select');
    if (!select) throw new Error('No log selector');
    return select;
  }

  function chooseLog(logName: string): void {
    logSelect().value = logName;
    logSelect().dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('offers the readable logs and shows the native-host log first', async () => {
    await openTab();

    expect([...logSelect().options].map((option) => option.value)).toEqual([
      'scheduler',
      'scheduler-launchd',
      'webapp',
      'ngrok',
      'native-host',
    ]);
    expect(logSelect().value).toBe('native-host');
    expect(sectionText('logs')).toContain('first line');
    expect(sectionText('logs')).toContain('second line');
  });

  it('opens one connection to the host and subscribes to the last 200 lines of every log', async () => {
    const fake = await openTab();

    expect(fake.connectNative).toHaveBeenCalledTimes(1);
    expect(fake.connectNative).toHaveBeenCalledWith(NATIVE_HOST_NAME);
    expect(fake.ports[0].postedMessages).toEqual([{ type: 'subscribeLogs', lineCount: 200 }]);
  });

  it('shows the newest log line at the top', async () => {
    await openTab();

    const logText = sectionText('logs');
    expect(logText.indexOf('second line')).toBeLessThan(logText.indexOf('first line'));
  });

  it('shows new lines as soon as the host pushes them, without waiting for a poll', async () => {
    const fake = await openTab();

    fake.ports[0].pushFromHost(
      logTailMessage('native-host', {
        isLogFilePresent: true,
        logLines: ['first line', 'second line', 'third line'],
      })
    );

    const logText = sectionText('logs');
    expect(logText.indexOf('third line')).toBeLessThan(logText.indexOf('second line'));
  });

  it('shows a chosen log from what the host already sent, with no further host request', async () => {
    const fake = await openTab(
      makeFakeChrome({
        logTails: {
          ...DEFAULT_LOG_TAILS_BY_LOG_NAME,
          webapp: { isLogFilePresent: true, logLines: ['webapp started'] },
        },
      })
    );
    const requestCountAfterOpen = fake.sendNativeMessage.mock.calls.length;

    chooseLog('webapp');

    expect(sectionText('logs')).toContain('webapp started');
    expect(sectionText('logs')).not.toContain('first line');
    expect(fake.sendNativeMessage.mock.calls).toHaveLength(requestCountAfterOpen);
    expect(fake.connectNative).toHaveBeenCalledTimes(1);
  });

  it('does not show an update for a log that is not the chosen one', async () => {
    const fake = await openTab();

    fake.ports[0].pushFromHost(
      logTailMessage('webapp', { isLogFilePresent: true, logLines: ['webapp noise'] })
    );

    expect(sectionText('logs')).not.toContain('webapp noise');
    chooseLog('webapp');
    expect(sectionText('logs')).toContain('webapp noise');
  });

  it('says so when the log file does not exist yet', async () => {
    await openTab(
      makeFakeChrome({
        logTails: {
          ...DEFAULT_LOG_TAILS_BY_LOG_NAME,
          'native-host': { isLogFilePresent: false, logLines: [] },
        },
      })
    );

    expect(sectionText('logs')).toContain('No log file yet');
  });

  it('shows log lines as text, never as markup', async () => {
    await openTab(
      makeFakeChrome({
        logTails: {
          ...DEFAULT_LOG_TAILS_BY_LOG_NAME,
          'native-host': { isLogFilePresent: true, logLines: ['<script>boom()</script>'] },
        },
      })
    );

    expect(root.querySelector('[data-section="logs"] script')).toBeNull();
    expect(sectionText('logs')).toContain('<script>boom()</script>');
  });

  it('shows a log the host cannot read in the logs panel, and keeps the other panels', async () => {
    const fake = await openTab();

    fake.ports[0].pushFromHost({ ok: false, error: 'Could not read the scheduler log: EACCES' });

    expect(sectionText('logs')).toContain('Could not read the scheduler log: EACCES');
    expect(sectionText('cookies')).toContain('Facebook cookies synced');
    expect(fake.ports[0].isDisconnected).toBe(false);
  });

  it('closes the connection while the page is hidden and reopens it when shown again', async () => {
    const fake = await openTab();

    setPageHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fake.ports[0].isDisconnected).toBe(true);

    setPageHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.connectNative).toHaveBeenCalledTimes(2);
    expect(fake.ports[1].postedMessages).toEqual([{ type: 'subscribeLogs', lineCount: 200 }]);
  });

  it('does not open a second connection on a poll while one is open', async () => {
    const fake = await openTab();

    await vi.advanceTimersByTimeAsync(90_000);

    expect(fake.connectNative).toHaveBeenCalledTimes(1);
  });

  it('says the live log stopped when the host drops the connection, and reconnects on the next poll', async () => {
    const fake = await openTab();

    fake.ports[0].closeFromHost();
    expect(sectionText('logs')).toContain('Lost the connection to the native host');
    expect(fake.connectNative).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fake.connectNative).toHaveBeenCalledTimes(2);
    expect(sectionText('logs')).toContain('first line');
  });

  it('says the live log is unavailable when the host cannot be reached at all', async () => {
    await openTab(makeFakeChrome({ hostUnreachableError: new Error('Native host not found') }));
    await vi.advanceTimersByTimeAsync(0);

    expect(sectionText('logs')).toContain('Lost the connection to the native host');
  });
});

function serviceRow(serviceName: string): HTMLElement {
  const row = root.querySelector<HTMLElement>(
    `[data-section="services"] [data-service="${serviceName}"]`
  );
  if (!row) throw new Error(`No row for ${serviceName}`);
  return row;
}

describe('startServerTab — services', () => {
  it('shows each service with its state', async () => {
    await openTab();

    expect(serviceRow('webapp').textContent).toContain('Webapp (dev server)');
    expect(serviceRow('webapp').textContent).toContain('Running (pid 4242)');
    expect(serviceRow('scheduler').textContent).toContain('Off');
    expect(serviceRow('ngrok').textContent).toContain('Not installed');
    expect(serviceRow('ngrok').textContent).toContain('npm run services:install');
  });

  it('offers only the actions that make sense for each state', async () => {
    await openTab();

    const actionsOf = (name: string) =>
      [...serviceRow(name).querySelectorAll<HTMLElement>('button')].map(
        (button) => button.dataset.action
      );
    expect(actionsOf('webapp')).toEqual(['restart', 'stop']);
    expect(actionsOf('scheduler')).toEqual(['start']);
    expect(actionsOf('ngrok')).toEqual([]);
  });

  it('sends the chosen action to the host, then shows the service as it now is', async () => {
    let isSchedulerRunning = false;
    const fake = makeFakeChrome({
      replies: {
        getServices: () => ({
          ok: true,
          servicesByName: {
            scheduler: {
              isInstalled: true,
              isIntervalJob: true,
              isLoaded: isSchedulerRunning,
              isRunning: isSchedulerRunning,
              isEnabled: isSchedulerRunning,
              pid: isSchedulerRunning ? 777 : null,
            },
          },
        }),
        controlService: () => {
          isSchedulerRunning = true;
          return { ok: true, serviceName: 'scheduler', state: {} };
        },
      },
    });
    await openTab(fake);

    await click('[data-service="scheduler"] button[data-action="start"]');

    expect(fake.requests).toContainEqual({
      type: 'controlService',
      serviceName: 'scheduler',
      action: 'start',
    });
    expect(serviceRow('scheduler').textContent).toContain('Running (pid 777)');
  });

  it("shows the host's message when an action fails, keeping the service as it was", async () => {
    const fake = makeFakeChrome({
      replies: {
        controlService: {
          ok: false,
          error: 'launchctl bootstrap failed (exit 5): Input/output error',
        },
      },
    });
    await openTab(fake);

    await click('[data-service="webapp"] button[data-action="restart"]');

    expect(sectionText('services')).toContain('Input/output error');
    expect(serviceRow('webapp').textContent).toContain('Running (pid 4242)');
  });

  it('sends one request when a button is clicked twice before the host answers', async () => {
    const heldControl = holdReply<unknown>();
    const fake = makeFakeChrome({ replies: { controlService: () => heldControl.reply } });
    await openTab(fake);

    const button = root.querySelector<HTMLElement>(
      '[data-service="scheduler"] button[data-action="start"]'
    );
    if (!button) throw new Error('No start button');
    button.click();
    button.click();
    heldControl.release({ ok: true, serviceName: 'scheduler', state: {} });
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.requests.filter((request) => request.type === 'controlService')).toHaveLength(1);
  });

  it('disables every service button while an action runs, then re-enables them', async () => {
    const heldControl = holdReply<unknown>();
    const fake = makeFakeChrome({ replies: { controlService: () => heldControl.reply } });
    await openTab(fake);

    await click('[data-service="webapp"] button[data-action="restart"]');

    const buttonsWhileRunning = [...root.querySelectorAll<HTMLButtonElement>('.service button')];
    expect(buttonsWhileRunning.length).toBeGreaterThan(1);
    expect(buttonsWhileRunning.every((button) => button.disabled)).toBe(true);

    heldControl.release({ ok: true, serviceName: 'webapp', state: {} });
    await vi.advanceTimersByTimeAsync(0);

    const buttonsAfterwards = [...root.querySelectorAll<HTMLButtonElement>('.service button')];
    expect(buttonsAfterwards.some((button) => button.disabled)).toBe(false);
  });

  it('drops the failure message once it is old', async () => {
    let clockMs = NOW_MS;
    const fake = makeFakeChrome({
      replies: { controlService: { ok: false, error: 'Input/output error' } },
    });
    await openTab(fake, () => clockMs);
    await click('[data-service="webapp"] button[data-action="restart"]');
    expect(sectionText('services')).toContain('Input/output error');

    clockMs += 5 * 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sectionText('services')).not.toContain('Input/output error');
  });
});

describe('startServerTab — layout', () => {
  function isBefore(first: Element, second: Element): boolean {
    return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  it('keeps a service status and its buttons on the first line, with the detail below them', async () => {
    await openTab(
      makeFakeChrome({
        replies: {
          getServices: {
            ok: true,
            servicesByName: {
              scheduler: {
                isInstalled: true,
                isIntervalJob: true,
                isLoaded: true,
                isRunning: false,
                isEnabled: true,
                pid: null,
              },
            },
          },
        },
      })
    );

    const row = serviceRow('scheduler');
    const status = row.querySelector('.service-status');
    const actions = row.querySelector('.service-actions');
    const detail = row.querySelector('.service-detail');
    if (!status || !actions || !detail) throw new Error('Scheduler row is missing a part');
    expect(isBefore(status, actions)).toBe(true);
    expect(isBefore(actions, detail)).toBe(true);
  });

  it('puts the Sync now button beside the cookie status rather than below it', async () => {
    await openTab();

    const button = root.querySelector('[data-section="cookies"] button');
    expect(button?.previousElementSibling?.textContent).toContain('Facebook cookies synced');
  });

  it('shows the logs above the last runs', async () => {
    await openTab();

    const sectionNames = [...root.children].map((child) => child.getAttribute('data-section'));
    expect(sectionNames).toEqual(['host-error', 'services', 'cookies', 'settings', 'logs', 'runs']);
  });

  it('labels the log chooser for screen readers without repeating the Logs heading', async () => {
    await openTab();

    const select = root.querySelector('[data-section="logs"] select');
    expect(select?.getAttribute('aria-label')).toBe('Log');
    expect(root.querySelector('[data-section="logs"] .field-label')).toBeNull();
  });
});
