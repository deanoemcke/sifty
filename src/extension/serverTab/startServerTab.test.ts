// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
};

// A stand-in for the `chrome` global: answers native messages from a table,
// and records every request so tests can see what the tab asked the host.
function makeFakeChrome(
  options: {
    replies?: Record<string, unknown | ((request: HostRequest) => unknown)>;
    hostUnreachableError?: Error;
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
    cookies: { getAll: async () => [], onChanged: { addListener: () => {} } },
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
});

function sectionText(sectionName: string): string {
  return root.querySelector(`[data-section="${sectionName}"]`)?.textContent ?? '';
}

async function openTab(fake = makeFakeChrome()) {
  await startServerTab(root, {
    chromeApi: fake.chromeApi,
    nowMs: () => NOW_MS,
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
