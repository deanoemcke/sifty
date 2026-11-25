import type Database from 'better-sqlite3';
import { stmtGetFacebookCookies, stmtUpsertFacebookCookies } from './db';

export const LOGIN_REQUIRED_MESSAGE = 'Facebook requires login. Log in to Facebook in Chrome.';

export class MissingFacebookCookiesError extends Error {
  constructor(reason?: string) {
    super(reason ? `${LOGIN_REQUIRED_MESSAGE} ${reason}` : LOGIN_REQUIRED_MESSAGE);
    this.name = 'MissingFacebookCookiesError';
  }
}

export type RawFacebookCookie = Record<string, unknown>;

export function cookieExpirySeconds(cookie: RawFacebookCookie): number | undefined {
  if (typeof cookie.expirationDate === 'number') return cookie.expirationDate;
  if (typeof cookie.expires === 'number') return cookie.expires;
  return undefined;
}

export class InvalidFacebookCookiePayloadError extends Error {
  constructor(reason: string) {
    super(`Facebook cookie payload rejected. ${reason}`);
    this.name = 'InvalidFacebookCookiePayloadError';
  }
}

const LOGIN_COOKIE_NAMES: ReadonlySet<string> = new Set(['c_user', 'xs']);

const MAX_COOKIE_PAYLOAD_BYTES = 64 * 1024;
const MAX_COOKIE_COUNT = 200;

function parseCookieArray(
  cookiesJson: string,
  createError: (reason: string) => Error
): RawFacebookCookie[] {
  let raw: unknown;
  try {
    raw = JSON.parse(cookiesJson);
  } catch {
    throw createError('The cookies are not valid JSON.');
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    throw createError('The cookies must be a non-empty JSON array.');
  }

  if (!raw.every(isCookieShaped)) {
    throw createError('Every cookie must be an object with a string name and value.');
  }

  return raw;
}

function isCookieShaped(element: unknown): element is RawFacebookCookie {
  return (
    typeof element === 'object' &&
    element !== null &&
    typeof (element as RawFacebookCookie).name === 'string' &&
    typeof (element as RawFacebookCookie).value === 'string'
  );
}

function requireLoginCookies(cookies: RawFacebookCookie[]): void {
  const presentNames = new Set(cookies.map((cookie) => String(cookie.name)));
  const missingNames = [...LOGIN_COOKIE_NAMES].filter((name) => !presentNames.has(name));
  if (missingNames.length > 0) {
    throw new MissingFacebookCookiesError(
      `The Facebook login cookies are incomplete (missing ${missingNames.join(', ')}).`
    );
  }
}

function requireUnexpiredCookies(cookies: RawFacebookCookie[]): RawFacebookCookie[] {
  const nowSeconds = Date.now() / 1000;
  const unexpired = cookies.filter((cookie) => {
    const expiry = cookieExpirySeconds(cookie);
    return expiry === undefined || expiry > nowSeconds;
  });

  if (unexpired.length === 0) {
    throw new MissingFacebookCookiesError('All the cookies have expired.');
  }

  return unexpired;
}

export function parseFbCookies(cookiesJson: string | undefined): RawFacebookCookie[] {
  if (!cookiesJson) throw new MissingFacebookCookiesError();

  return requireUnexpiredCookies(
    parseCookieArray(cookiesJson, (reason) => new MissingFacebookCookiesError(reason))
  );
}

export function saveFacebookCookies(database: Database.Database, cookiesJson: string): void {
  if (Buffer.byteLength(cookiesJson, 'utf8') > MAX_COOKIE_PAYLOAD_BYTES) {
    throw new InvalidFacebookCookiePayloadError('The payload is larger than 64 KiB.');
  }
  const payloadCookies = parseCookieArray(
    cookiesJson,
    (reason) => new InvalidFacebookCookiePayloadError(reason)
  );
  if (payloadCookies.length > MAX_COOKIE_COUNT) {
    throw new InvalidFacebookCookiePayloadError(
      `The set has more than ${MAX_COOKIE_COUNT} cookies.`
    );
  }
  const unexpiredCookies = requireUnexpiredCookies(payloadCookies);
  requireLoginCookies(unexpiredCookies);

  stmtUpsertFacebookCookies(database).run(JSON.stringify(unexpiredCookies), Date.now());
}

export function getStoredFacebookCookiesJson(database: Database.Database): string | undefined {
  return stmtGetFacebookCookies(database).get()?.cookies_json;
}

function parseUsableFacebookCookies(cookiesJson: string | undefined): RawFacebookCookie[] {
  const unexpiredCookies = parseFbCookies(cookiesJson);
  requireLoginCookies(unexpiredCookies);
  return unexpiredCookies;
}

export function loadFacebookCookies(database: Database.Database): RawFacebookCookie[] {
  return parseUsableFacebookCookies(getStoredFacebookCookiesJson(database));
}

export type FacebookCookieStatus =
  | { isSynced: false }
  | {
      isSynced: true;
      syncedAtMs: number;
      // false when loading would throw: the stored set exists but Facebook
      // scraping cannot use it.
      isLoginUsable: false;
      unusableReason: string;
    }
  | {
      isSynced: true;
      syncedAtMs: number;
      isLoginUsable: true;
      // Unexpired cookies only, the same set loadFacebookCookies returns.
      cookieCount: number;
      // When the session ends: the earliest expiry among the login cookies.
      // null when any login cookie is a session cookie, since the session then
      // ends at an unknown time (a persistent sibling is only an upper bound).
      loginExpiryMs: number | null;
    };

export function getFacebookCookieStatus(database: Database.Database): FacebookCookieStatus {
  const row = stmtGetFacebookCookies(database).get();
  if (!row) return { isSynced: false };

  let unexpiredCookies: RawFacebookCookie[];
  try {
    unexpiredCookies = parseUsableFacebookCookies(row.cookies_json);
  } catch (error) {
    if (!(error instanceof MissingFacebookCookiesError)) throw error;
    return {
      isSynced: true,
      syncedAtMs: row.synced_at,
      isLoginUsable: false,
      unusableReason: error.message,
    };
  }

  const loginExpiriesSeconds = unexpiredCookies
    .filter((cookie) => LOGIN_COOKIE_NAMES.has(String(cookie.name)))
    .map(cookieExpirySeconds);
  const hasSessionLoginCookie = loginExpiriesSeconds.some(
    (expirySeconds) => expirySeconds === undefined
  );

  return {
    isSynced: true,
    syncedAtMs: row.synced_at,
    isLoginUsable: true,
    cookieCount: unexpiredCookies.length,
    loginExpiryMs: hasSessionLoginCookie
      ? null
      : Math.min(...(loginExpiriesSeconds as number[])) * 1000,
  };
}
