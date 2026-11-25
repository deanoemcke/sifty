// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  tailLog: { ok: true, isLogFilePresent: true, logLines: ['first line', 'second line'] },
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

// A stand-in for the `chrome` global: answers native messages from a table,
// and records every request so tests can see what the tab asked the host.
function makeFakeChrome(
  options: {
    replies?: Record<string, unknown | ((request: HostRequest) => unknown)>;
    hostUnreachableError?: Error;
    browserCookies?: BrowserCookie[];
  } = {}
) {
  const replies = { ...DEFAULT_REPLIES, ...options.replies };
  const requests: HostRequest[] = [];
  const sendNativeMessage = vi.fn(async (_hostName: string, message: unknown) => {
    const request = message as HostRequest;
    requests.push(request);
    if (options.hostUnreachableError) throw options.hostUnreachableError;
    const reply = replies[request.type];
    return typeof reply === 'function' ? reply(request) : reply;
  });

  const chromeApi: ChromeApi = {
    cookies: {
      getAll: async () => options.browserCookies ?? [],
      onChanged: { addListener: () => {} },
    },
    runtime: {
      sendNativeMessage,
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };
  return { chromeApi, requests };
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

// A host reply that stays pending until the test lets it through.
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
  it('fetches again with the newly chosen log instead of showing the old log under the new name', async () => {
    const heldTail = holdReply<unknown>();
    let shouldHoldTail = false;
    const fake = makeFakeChrome({
      replies: {
        tailLog: (request: HostRequest) =>
          shouldHoldTail
            ? heldTail.reply
            : { ok: true, isLogFilePresent: true, logLines: [`content of ${request.logName}`] },
      },
    });
    await openTab(fake);
    shouldHoldTail = true;
    await vi.advanceTimersByTimeAsync(30_000);

    const select = root.querySelector<HTMLSelectElement>('[data-section="logs"] select');
    if (!select) throw new Error('No log selector');
    shouldHoldTail = false;
    select.value = 'webapp';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    heldTail.release({ ok: true, isLogFilePresent: true, logLines: ['content of scheduler'] });
    await vi.advanceTimersByTimeAsync(0);

    expect(sectionText('logs')).toContain('content of webapp');
    expect(sectionText('logs')).not.toContain('content of scheduler');
  });

  it('shows the state after a service action even when a poll was already in flight', async () => {
    let isWebappRunning = true;
    const heldTail = holdReply<unknown>();
    let shouldHoldTail = false;
    const fake = makeFakeChrome({
      replies: {
        tailLog: () =>
          shouldHoldTail ? heldTail.reply : { ok: true, isLogFilePresent: true, logLines: [] },
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
    heldTail.release({ ok: true, isLogFilePresent: true, logLines: [] });
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

  it('offers the readable logs and shows the last 200 lines of the scheduler log first', async () => {
    const fake = await openTab();

    expect([...logSelect().options].map((option) => option.value)).toEqual([
      'scheduler',
      'scheduler-launchd',
      'webapp',
      'ngrok',
      'native-host',
    ]);
    expect(logSelect().value).toBe('scheduler');
    expect(fake.requests).toContainEqual({ type: 'tailLog', logName: 'scheduler', lineCount: 200 });
    expect(sectionText('logs')).toContain('first line');
    expect(sectionText('logs')).toContain('second line');
  });

  it('loads another log when it is chosen', async () => {
    const fake = await openTab();

    logSelect().value = 'native-host';
    logSelect().dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.requests).toContainEqual({
      type: 'tailLog',
      logName: 'native-host',
      lineCount: 200,
    });
  });

  it('says so when the log file does not exist yet', async () => {
    await openTab(
      makeFakeChrome({ replies: { tailLog: { ok: true, isLogFilePresent: false, logLines: [] } } })
    );

    expect(sectionText('logs')).toContain('No log file yet');
  });

  it('shows log lines as text, never as markup', async () => {
    await openTab(
      makeFakeChrome({
        replies: {
          tailLog: { ok: true, isLogFilePresent: true, logLines: ['<script>boom()</script>'] },
        },
      })
    );

    expect(root.querySelector('[data-section="logs"] script')).toBeNull();
    expect(sectionText('logs')).toContain('<script>boom()</script>');
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
