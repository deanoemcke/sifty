import { describeError } from '../nativeHost/describeError';
import { NATIVE_HOST_NAME } from '../nativeHost/hostName';
import { buildNativeHostRequest, type NativeHostRequest } from '../nativeHost/protocol';
import {
  type BrowserCookie,
  FACEBOOK_DOMAIN,
  isFacebookCookieDomain,
  toSyncableFacebookCookies,
} from './cookieSync';
import { createCookieSyncScheduler } from './syncScheduler';

export type ChromeApi = {
  cookies: {
    getAll(details: { domain: string }): Promise<BrowserCookie[]>;
    onChanged: { addListener(listener: (changeInfo: { cookie: BrowserCookie }) => void): void };
  };
  runtime: {
    sendNativeMessage(hostName: string, message: NativeHostRequest): Promise<unknown>;
    onStartup: { addListener(listener: () => void): void };
    onInstalled: { addListener(listener: () => void): void };
  };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): void;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
};

export type CookieSyncOutcome =
  | { kind: 'synced'; cookieCount: number }
  | { kind: 'no-facebook-cookies' }
  | { kind: 'host-rejected'; error: string }
  | { kind: 'host-unreachable'; error: string };

export const COOKIE_SYNC_WAIT_MS = 5000;
export const COOKIE_SYNC_MAX_WAIT_MS = 60_000;
export const COOKIE_RESYNC_ALARM_NAME = 'sifty-cookie-resync';
export const COOKIE_RESYNC_PERIOD_MINUTES = 60;

function interpretHostReply(reply: unknown, sentCookieCount: number): CookieSyncOutcome {
  if (typeof reply === 'object' && reply !== null && 'ok' in reply) {
    if (reply.ok === true) return { kind: 'synced', cookieCount: sentCookieCount };
    if ('error' in reply && typeof reply.error === 'string') {
      return { kind: 'host-rejected', error: reply.error };
    }
  }
  return { kind: 'host-rejected', error: 'Unexpected reply from the native host' };
}

export async function syncFacebookCookiesAsync(chromeApi: ChromeApi): Promise<CookieSyncOutcome> {
  const browserCookies = await chromeApi.cookies.getAll({ domain: FACEBOOK_DOMAIN });
  const syncableCookies = toSyncableFacebookCookies(browserCookies);
  if (syncableCookies.length === 0) return { kind: 'no-facebook-cookies' };

  try {
    const reply = await chromeApi.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      buildNativeHostRequest('syncCookies', { cookiesJson: JSON.stringify(syncableCookies) })
    );
    return interpretHostReply(reply, syncableCookies.length);
  } catch (error) {
    return { kind: 'host-unreachable', error: describeError(error) };
  }
}

export function describeSyncOutcome(outcome: CookieSyncOutcome): string {
  switch (outcome.kind) {
    case 'synced':
      return `Cookie sync succeeded: sent ${outcome.cookieCount} Facebook cookies`;
    case 'no-facebook-cookies':
      return 'Cookie sync skipped: no Facebook cookies in this browser (not logged in?)';
    case 'host-rejected':
      return `Cookie sync rejected by the host: ${outcome.error}`;
    case 'host-unreachable':
      return `Cookie sync failed, native messaging host unreachable: ${outcome.error}`;
  }
}

export function startCookieSync(chromeApi: ChromeApi, options: { log: (message: string) => void }) {
  const scheduler = createCookieSyncScheduler({
    waitMs: COOKIE_SYNC_WAIT_MS,
    maxWaitMs: COOKIE_SYNC_MAX_WAIT_MS,
    syncAsync: async () => {
      options.log(describeSyncOutcome(await syncFacebookCookiesAsync(chromeApi)));
    },
    onSyncError: (error) => options.log(`Cookie sync failed unexpectedly: ${describeError(error)}`),
  });

  chromeApi.cookies.onChanged.addListener((changeInfo) => {
    if (isFacebookCookieDomain(changeInfo.cookie.domain)) scheduler.requestSync();
  });
  chromeApi.runtime.onStartup.addListener(() => scheduler.requestSync());
  chromeApi.runtime.onInstalled.addListener(() => scheduler.requestSync());

  chromeApi.alarms.create(COOKIE_RESYNC_ALARM_NAME, {
    periodInMinutes: COOKIE_RESYNC_PERIOD_MINUTES,
  });
  chromeApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === COOKIE_RESYNC_ALARM_NAME) scheduler.requestSync();
  });
}
