import { describe, expect, it } from 'vitest';
import { describeCookieStatus } from './describeCookieStatus';

const NOW_MS = Date.parse('2026-11-25T00:00:00Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function syncedStatus(overrides: { syncedAgoMs?: number; loginExpiresInMs?: number | null } = {}) {
  const loginExpiresInMs =
    overrides.loginExpiresInMs === undefined ? 81 * DAY_MS : overrides.loginExpiresInMs;
  return {
    isSynced: true as const,
    syncedAtMs: NOW_MS - (overrides.syncedAgoMs ?? 2 * MINUTE_MS),
    cookieCount: 10,
    loginExpiryMs: loginExpiresInMs === null ? null : NOW_MS + loginExpiresInMs,
  };
}

describe('describeCookieStatus', () => {
  it('flags cookies that have never been synced as a problem and says what to do', () => {
    expect(describeCookieStatus({ isSynced: false }, NOW_MS)).toEqual({
      tone: 'problem',
      headline: 'Facebook cookies not synced',
      detail: 'Log in to Facebook in Chrome. The extension syncs your cookies automatically.',
    });
  });

  it('reports a healthy sync with its age, cookie count and remaining login time', () => {
    expect(describeCookieStatus(syncedStatus(), NOW_MS)).toEqual({
      tone: 'ok',
      headline: 'Facebook cookies synced',
      detail: 'Synced 2 minutes ago · 10 cookies · login valid for 81 days',
    });
  });

  it('uses the singular for one minute', () => {
    const view = describeCookieStatus(syncedStatus({ syncedAgoMs: MINUTE_MS }), NOW_MS);

    expect(view.detail).toContain('Synced 1 minute ago');
  });

  it('says "less than a minute" for a very recent sync', () => {
    const view = describeCookieStatus(syncedStatus({ syncedAgoMs: 5000 }), NOW_MS);

    expect(view.detail).toContain('Synced less than a minute ago');
  });

  it('warns when the login expires within 14 days', () => {
    const view = describeCookieStatus(syncedStatus({ loginExpiresInMs: 9 * DAY_MS }), NOW_MS);

    expect(view).toMatchObject({ tone: 'warning', headline: 'Facebook login expires in 9 days' });
  });

  it('does not warn at exactly 15 days', () => {
    const view = describeCookieStatus(syncedStatus({ loginExpiresInMs: 15 * DAY_MS }), NOW_MS);

    expect(view.tone).toBe('ok');
  });

  it('flags an expired login as a problem', () => {
    const view = describeCookieStatus(syncedStatus({ loginExpiresInMs: -1 * HOUR_MS }), NOW_MS);

    expect(view).toMatchObject({ tone: 'problem', headline: 'Facebook login has expired' });
    expect(view.detail).toContain('Log in to Facebook again in Chrome');
  });

  it('reports login cookies without an expiry date as fine', () => {
    const view = describeCookieStatus(syncedStatus({ loginExpiresInMs: null }), NOW_MS);

    expect(view).toEqual({
      tone: 'ok',
      headline: 'Facebook cookies synced',
      detail: 'Synced 2 minutes ago · 10 cookies · login cookies have no expiry date',
    });
  });

  it('warns when the last sync is over a day old, since the extension resyncs hourly', () => {
    const view = describeCookieStatus(syncedStatus({ syncedAgoMs: 3 * DAY_MS }), NOW_MS);

    expect(view).toMatchObject({
      tone: 'warning',
      headline: 'Facebook cookies not synced recently',
    });
    expect(view.detail).toContain('3 days ago');
  });

  it('reports hours for a sync that is a few hours old', () => {
    const view = describeCookieStatus(syncedStatus({ syncedAgoMs: 5 * HOUR_MS }), NOW_MS);

    expect(view.detail).toContain('Synced 5 hours ago');
  });
});
