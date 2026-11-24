// Server-side only — Facebook session cookies: parsing, validation and storage.

import type Database from 'better-sqlite3';
import { stmtGetFacebookCookies, stmtUpsertFacebookCookies } from './db';

// Exported so scheduler.ts can recognize this specific failure across every
// saved search that hits it — see isFacebookCookieFailure there, which
// collapses what would otherwise be one duplicate alert per affected saved
// search into a single application-wide alert.
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

// Thrown when a payload offered for storing is itself unusable (too big, too
// many cookies, not a JSON array). That is a fault in the sync, not in the user's
// Facebook login, so it deliberately does not carry LOGIN_REQUIRED_MESSAGE.
export class InvalidFacebookCookiePayloadError extends Error {
  constructor(reason: string) {
    super(`Facebook cookie payload rejected. ${reason}`);
    this.name = 'InvalidFacebookCookiePayloadError';
  }
}

// Facebook's other cookies (wd, presence, dpr, …) are short-lived or cosmetic and
// rotate constantly; only these two decide whether the login is still valid.
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

// A sync from a Chrome that is logged out of Facebook still carries cookies
// (datr, sb, …) but not the login pair, and must not replace a working login.
function requireLoginCookie(cookies: RawFacebookCookie[]): void {
  if (!cookies.some((cookie) => LOGIN_COOKIE_NAMES.has(String(cookie.name)))) {
    throw new MissingFacebookCookiesError('No Facebook login cookies were found.');
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

// Parses a JSON array of cookies (as synced from Chrome by the Sifty Server
// extension). Validated up front so a missing/malformed/expired cookie set fails
// immediately, before any browser is launched or network request made, instead
// of only surfacing after a full, doomed scrape attempt.
export function parseFbCookies(cookiesJson: string | undefined): RawFacebookCookie[] {
  if (!cookiesJson) throw new MissingFacebookCookiesError();

  return requireUnexpiredCookies(
    parseCookieArray(cookiesJson, (reason) => new MissingFacebookCookiesError(reason))
  );
}

// Cookies arrive from outside the process (the browser extension), so size and
// count are capped on the payload as received (before the expiry filter), and the
// set is fully validated before it replaces what's stored — a rejected sync
// leaves the previous cookies in use. Structurally unusable payloads throw
// InvalidFacebookCookiePayloadError; a payload whose cookies have all expired,
// or that has no unexpired login cookie, throws MissingFacebookCookiesError,
// since the user needs to log in again.
// One row (id = 1): the newest set replaces the previous one wholesale, so there
// is never a mix of old and new cookies.
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
  requireLoginCookie(unexpiredCookies);

  stmtUpsertFacebookCookies(database).run(JSON.stringify(unexpiredCookies), Date.now());
}

export function getStoredFacebookCookiesJson(database: Database.Database): string | undefined {
  return stmtGetFacebookCookies(database).get()?.cookies_json;
}

// The stored cookies, validated: throws MissingFacebookCookiesError when none
// have been synced or all have expired, so callers fail fast before any browser
// is launched.
export function loadFacebookCookies(database: Database.Database): RawFacebookCookie[] {
  return parseFbCookies(getStoredFacebookCookiesJson(database));
}

export type FacebookCookieStatus =
  | { isSynced: false }
  | {
      isSynced: true;
      syncedAtMs: number;
      cookieCount: number;
      // When the session ends: the earliest expiry among the login cookies.
      // null when they are session cookies (no expiry) or absent.
      loginExpiryMs: number | null;
    };

// Metadata only — cookie values never leave this module through the status.
export function getFacebookCookieStatus(database: Database.Database): FacebookCookieStatus {
  const row = stmtGetFacebookCookies(database).get();
  if (!row) return { isSynced: false };

  const storedCookies = JSON.parse(row.cookies_json) as RawFacebookCookie[];
  const loginExpiriesSeconds = storedCookies
    .filter((cookie) => LOGIN_COOKIE_NAMES.has(String(cookie.name)))
    .map(cookieExpirySeconds)
    .filter((expirySeconds) => expirySeconds !== undefined);

  return {
    isSynced: true,
    syncedAtMs: row.synced_at,
    cookieCount: storedCookies.length,
    loginExpiryMs:
      loginExpiriesSeconds.length > 0 ? Math.min(...loginExpiriesSeconds) * 1000 : null,
  };
}
