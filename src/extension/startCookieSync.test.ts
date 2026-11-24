import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCookie } from './cookieSync';
import { type ChromeApi, startCookieSync } from './startCookieSync';

function makeBrowserCookie(overrides: Partial<BrowserCookie> = {}): BrowserCookie {
  return {
    name: 'xs',
    value: 'session-value',
    domain: '.facebook.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'no_restriction',
    hostOnly: false,
    session: false,
    storeId: '0',
    expirationDate: 1_900_000_000,
    ...overrides,
  };
}

// A stand-in for the `chrome` global that records the listeners the extension
// registers, so tests can fire browser events by hand.
function makeFakeChrome(options: {
  browserCookies?: BrowserCookie[];
  hostReply?: unknown;
  sendNativeMessageError?: Error;
}) {
  const listenersByEvent = {
    cookieChanged: [] as Array<(changeInfo: { cookie: BrowserCookie }) => void>,
    startup: [] as Array<() => void>,
    installed: [] as Array<() => void>,
    alarm: [] as Array<(alarm: { name: string }) => void>,
  };
  const sendNativeMessage = vi.fn(async () => {
    if (options.sendNativeMessageError) throw options.sendNativeMessageError;
    return options.hostReply ?? { ok: true, cookies: { isSynced: true } };
  });
  const createdAlarms: Array<{ name: string; periodInMinutes: number }> = [];

  const chromeApi: ChromeApi = {
    cookies: {
      getAll: async () => options.browserCookies ?? [makeBrowserCookie()],
      onChanged: { addListener: (listener) => listenersByEvent.cookieChanged.push(listener) },
    },
    runtime: {
      sendNativeMessage,
      onStartup: { addListener: (listener) => listenersByEvent.startup.push(listener) },
      onInstalled: { addListener: (listener) => listenersByEvent.installed.push(listener) },
    },
    alarms: {
      create: (name, info) => createdAlarms.push({ name, periodInMinutes: info.periodInMinutes }),
      onAlarm: { addListener: (listener) => listenersByEvent.alarm.push(listener) },
    },
  };

  return { chromeApi, listenersByEvent, sendNativeMessage, createdAlarms };
}

describe('startCookieSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the Facebook cookies to the host a few seconds after one changes', async () => {
    const fake = makeFakeChrome({});
    startCookieSync(fake.chromeApi, { log: vi.fn() });

    fake.listenersByEvent.cookieChanged[0]({ cookie: makeBrowserCookie() });
    expect(fake.sendNativeMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);

    expect(fake.sendNativeMessage).toHaveBeenCalledTimes(1);
    const [hostName, message] = fake.sendNativeMessage.mock.calls[0] as unknown as [
      string,
      { type: string; cookiesJson: string },
    ];
    expect(hostName).toBe('com.sifty.server');
    expect(message.type).toBe('syncCookies');
    expect(JSON.parse(message.cookiesJson)).toEqual([
      expect.objectContaining({ name: 'xs', value: 'session-value', httpOnly: true }),
    ]);
  });

  it('logs each successful sync with how many cookies were sent', async () => {
    const fake = makeFakeChrome({
      browserCookies: [makeBrowserCookie(), makeBrowserCookie({ name: 'c_user', httpOnly: false })],
    });
    const log = vi.fn();
    startCookieSync(fake.chromeApi, { log });

    fake.listenersByEvent.startup[0]();
    await vi.advanceTimersByTimeAsync(5000);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Cookie sync succeeded: sent 2 Facebook cookies');
  });

  it('ignores a change to a cookie from another site', async () => {
    const fake = makeFakeChrome({});
    startCookieSync(fake.chromeApi, { log: vi.fn() });

    fake.listenersByEvent.cookieChanged[0]({
      cookie: makeBrowserCookie({ domain: '.example.com' }),
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fake.sendNativeMessage).not.toHaveBeenCalled();
  });

  it('syncs when the browser starts and when the extension is installed or updated', async () => {
    const fake = makeFakeChrome({});
    startCookieSync(fake.chromeApi, { log: vi.fn() });

    fake.listenersByEvent.startup[0]();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.sendNativeMessage).toHaveBeenCalledTimes(1);

    fake.listenersByEvent.installed[0]();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.sendNativeMessage).toHaveBeenCalledTimes(2);
  });

  it('schedules an hourly resync so a missed update repairs itself', async () => {
    const fake = makeFakeChrome({});
    startCookieSync(fake.chromeApi, { log: vi.fn() });

    expect(fake.createdAlarms).toEqual([{ name: 'sifty-cookie-resync', periodInMinutes: 60 }]);

    fake.listenersByEvent.alarm[0]({ name: 'some-other-alarm' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.sendNativeMessage).not.toHaveBeenCalled();

    fake.listenersByEvent.alarm[0]({ name: 'sifty-cookie-resync' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.sendNativeMessage).toHaveBeenCalledTimes(1);
  });

  it('does not send anything, and says why, when there are no Facebook cookies', async () => {
    const fake = makeFakeChrome({ browserCookies: [] });
    const log = vi.fn();
    startCookieSync(fake.chromeApi, { log });

    fake.listenersByEvent.startup[0]();
    await vi.advanceTimersByTimeAsync(5000);

    expect(fake.sendNativeMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no Facebook cookies'));
  });

  it('logs the host error when the host rejects the cookies', async () => {
    const fake = makeFakeChrome({ hostReply: { ok: false, error: 'All cookies have expired.' } });
    const log = vi.fn();
    startCookieSync(fake.chromeApi, { log });

    fake.listenersByEvent.startup[0]();
    await vi.advanceTimersByTimeAsync(5000);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('All cookies have expired.'));
  });

  it('logs the failure when the host cannot be started, and keeps syncing later', async () => {
    const fake = makeFakeChrome({
      sendNativeMessageError: new Error('Specified native messaging host not found.'),
    });
    const log = vi.fn();
    startCookieSync(fake.chromeApi, { log });

    fake.listenersByEvent.startup[0]();
    await vi.advanceTimersByTimeAsync(5000);
    fake.listenersByEvent.startup[0]();
    await vi.advanceTimersByTimeAsync(5000);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('native messaging host not found'));
    expect(fake.sendNativeMessage).toHaveBeenCalledTimes(2);
  });
});
