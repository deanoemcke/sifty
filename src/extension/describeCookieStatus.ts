import type { FacebookCookieStatus } from '../server/facebookCookies';
import { DAY_MS, formatDuration, MINUTE_MS, pluralise } from './formatDuration';
import { COOKIE_RESYNC_PERIOD_MINUTES } from './startCookieSync';

// 'neutral' is for a state that is intended, such as a service parked off.
export type StatusTone = 'ok' | 'warning' | 'problem' | 'neutral';

export type CookieStatusView = {
  tone: StatusTone;
  headline: string;
  detail: string;
};

const LOGIN_EXPIRY_WARNING_MS = 14 * DAY_MS;
// A day of missed resyncs means Chrome has been closed or the extension is broken.
const STALE_SYNC_MS = 24 * COOKIE_RESYNC_PERIOD_MINUTES * MINUTE_MS;

export function describeCookieStatus(
  status: FacebookCookieStatus,
  nowMs: number
): CookieStatusView {
  if (!status.isSynced) {
    return {
      tone: 'problem',
      headline: 'Facebook cookies not synced',
      detail: 'Log in to Facebook in Chrome. The extension syncs your cookies automatically.',
    };
  }

  const syncedAge = formatDuration(nowMs - status.syncedAtMs);

  if (!status.isLoginUsable) {
    return {
      tone: 'problem',
      headline: 'Facebook login cannot be used',
      detail: `${status.unusableReason} Last synced ${syncedAge} ago.`,
    };
  }

  const cookieCount = pluralise(status.cookieCount, 'cookie');

  if (status.loginExpiryMs !== null && status.loginExpiryMs <= nowMs) {
    return {
      tone: 'problem',
      headline: 'Facebook login has expired',
      detail: `Log in to Facebook again in Chrome. Last synced ${syncedAge} ago.`,
    };
  }

  if (nowMs - status.syncedAtMs > STALE_SYNC_MS) {
    return {
      tone: 'warning',
      headline: 'Facebook cookies not synced recently',
      detail: `Last synced ${syncedAge} ago. Is Chrome closed, or is the extension disabled?`,
    };
  }

  if (status.loginExpiryMs === null) {
    return {
      tone: 'ok',
      headline: 'Facebook cookies synced',
      detail: `Synced ${syncedAge} ago · ${cookieCount} · login cookies have no expiry date`,
    };
  }

  const loginRemainingMs = status.loginExpiryMs - nowMs;
  if (loginRemainingMs <= LOGIN_EXPIRY_WARNING_MS) {
    return {
      tone: 'warning',
      headline: `Facebook login expires in ${formatDuration(loginRemainingMs)}`,
      detail: `Synced ${syncedAge} ago · ${cookieCount} · log in to Facebook in Chrome before then`,
    };
  }

  return {
    tone: 'ok',
    headline: 'Facebook cookies synced',
    detail: `Synced ${syncedAge} ago · ${cookieCount} · login valid for ${formatDuration(loginRemainingMs)}`,
  };
}
