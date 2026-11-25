export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  hostOnly: boolean;
  session: boolean;
  storeId: string;
  // Seconds since the epoch; absent for session cookies.
  expirationDate?: number;
};

export type SyncableCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  expirationDate?: number;
};

export const FACEBOOK_DOMAIN = 'facebook.com';

export function isFacebookCookieDomain(cookieDomain: string): boolean {
  const domain = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  return domain === FACEBOOK_DOMAIN || domain.endsWith(`.${FACEBOOK_DOMAIN}`);
}

export function toSyncableFacebookCookies(browserCookies: BrowserCookie[]): SyncableCookie[] {
  return browserCookies
    .filter((cookie) => isFacebookCookieDomain(cookie.domain))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(cookie.session || cookie.expirationDate === undefined
        ? {}
        : { expirationDate: cookie.expirationDate }),
    }));
}
