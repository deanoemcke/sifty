// Server-side only — Facebook session cookies: parsing, validation and storage.

import type Database from 'better-sqlite3';

// Exported so scheduler.ts can recognize this specific failure across every
// saved search that hits it — see isFacebookCookieFailure there, which
// collapses what would otherwise be one duplicate alert per affected saved
// search into a single application-wide alert.
export const LOGIN_REQUIRED_MESSAGE =
  'Facebook requires login. Set FB_COOKIES environment variable.';

export class MissingFacebookCookiesError extends Error {
  constructor(reason: string) {
    super(reason ? `${LOGIN_REQUIRED_MESSAGE} ${reason}` : LOGIN_REQUIRED_MESSAGE);
    this.name = 'MissingFacebookCookiesError';
  }
}

export type RawFacebookCookie = Record<string, unknown>;

function cookieExpirySeconds(cookie: RawFacebookCookie): number | undefined {
  if (typeof cookie.expirationDate === 'number') return cookie.expirationDate;
  if (typeof cookie.expires === 'number') return cookie.expires;
  return undefined;
}

// FB_COOKIES: JSON array of cookies exported from your browser (e.g. via the
// "Cookie Editor" extension — Export > Export as JSON). Validated up front so a
// missing/malformed/expired cookie set fails immediately, before any browser is
// launched or network request made, instead of only surfacing after a full,
// doomed scrape attempt.
export function parseFbCookies(cookiesJson: string | undefined): RawFacebookCookie[] {
  if (!cookiesJson) throw new MissingFacebookCookiesError('');

  let raw: unknown;
  try {
    raw = JSON.parse(cookiesJson);
  } catch {
    throw new MissingFacebookCookiesError('FB_COOKIES is not valid JSON.');
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MissingFacebookCookiesError('FB_COOKIES must be a non-empty JSON array of cookies.');
  }

  const nowSeconds = Date.now() / 1000;
  const unexpired = (raw as RawFacebookCookie[]).filter((cookie) => {
    const expiry = cookieExpirySeconds(cookie);
    return expiry === undefined || expiry > nowSeconds;
  });

  if (unexpired.length === 0) {
    throw new MissingFacebookCookiesError('All cookies in FB_COOKIES have expired.');
  }

  return unexpired;
}

// One row (id = 1): the most recently synced cookie set replaces the previous
// one wholesale, so there is never a mix of old and new cookies.
const MAX_COOKIE_PAYLOAD_BYTES = 64 * 1024;
const MAX_COOKIE_COUNT = 200;

// Cookies arrive from outside the process (the browser extension), so size and
// count are capped before parsing, and the set is fully validated before it
// replaces what's stored — a rejected sync leaves the previous cookies in use.
export function saveFacebookCookies(database: Database.Database, cookiesJson: string): void {
  if (Buffer.byteLength(cookiesJson, 'utf8') > MAX_COOKIE_PAYLOAD_BYTES) {
    throw new Error('Facebook cookie payload is larger than 64 KiB.');
  }
  const unexpiredCookies = parseFbCookies(cookiesJson);
  if (unexpiredCookies.length > MAX_COOKIE_COUNT) {
    throw new Error(`Facebook cookie set has more than ${MAX_COOKIE_COUNT} cookies.`);
  }

  database
    .prepare<[string, number]>(
      `INSERT INTO facebook_cookies (id, cookies_json, synced_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cookies_json = excluded.cookies_json, synced_at = excluded.synced_at`
    )
    .run(JSON.stringify(unexpiredCookies), Date.now());
}

export function getStoredFacebookCookiesJson(database: Database.Database): string | undefined {
  return database
    .prepare<[], { cookies_json: string }>('SELECT cookies_json FROM facebook_cookies WHERE id = 1')
    .get()?.cookies_json;
}

export type FacebookCookieStatus =
  | { isSynced: false }
  | {
      isSynced: true;
      syncedAtMs: number;
      cookieCount: number;
      earliestExpiryMs: number | null;
    };

// Metadata only — cookie values never leave this module through the status.
export function getFacebookCookieStatus(database: Database.Database): FacebookCookieStatus {
  const row = database
    .prepare<[], { cookies_json: string; synced_at: number }>(
      'SELECT cookies_json, synced_at FROM facebook_cookies WHERE id = 1'
    )
    .get();
  if (!row) return { isSynced: false };

  const storedCookies = JSON.parse(row.cookies_json) as RawFacebookCookie[];
  const expiriesSeconds = storedCookies
    .map(cookieExpirySeconds)
    .filter((expirySeconds) => expirySeconds !== undefined);

  return {
    isSynced: true,
    syncedAtMs: row.synced_at,
    cookieCount: storedCookies.length,
    earliestExpiryMs: expiriesSeconds.length > 0 ? Math.min(...expiriesSeconds) * 1000 : null,
  };
}
