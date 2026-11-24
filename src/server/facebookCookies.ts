// Server-side only — Facebook session cookies: parsing and validation.

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
