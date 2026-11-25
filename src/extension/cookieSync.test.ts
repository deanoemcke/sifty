import { describe, expect, it } from 'vitest';
import { type BrowserCookie, toSyncableFacebookCookies } from './cookieSync';

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

describe('toSyncableFacebookCookies', () => {
  it('keeps the fields the host needs, including HttpOnly session cookies', () => {
    expect(toSyncableFacebookCookies([makeBrowserCookie()])).toEqual([
      {
        name: 'xs',
        value: 'session-value',
        domain: '.facebook.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
        expirationDate: 1_900_000_000,
      },
    ]);
  });

  it('leaves out the expiry of a session cookie', () => {
    const [cookie] = toSyncableFacebookCookies([
      makeBrowserCookie({ session: true, expirationDate: undefined }),
    ]);

    expect(cookie).not.toHaveProperty('expirationDate');
  });

  it('does not pass along browser-internal fields', () => {
    const [cookie] = toSyncableFacebookCookies([makeBrowserCookie()]);

    expect(Object.keys(cookie).sort()).toEqual(
      ['domain', 'expirationDate', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value'].sort()
    );
  });

  it.each([
    '.facebook.com',
    'facebook.com',
    'www.facebook.com',
    'm.facebook.com',
  ])('accepts a cookie on %s', (domain) => {
    expect(toSyncableFacebookCookies([makeBrowserCookie({ domain })])).toHaveLength(1);
  });

  it.each([
    'notfacebook.com',
    '.notfacebook.com',
    'facebook.com.evil.example',
    'example.com',
    '',
  ])('rejects a cookie on %s', (domain) => {
    expect(toSyncableFacebookCookies([makeBrowserCookie({ domain })])).toEqual([]);
  });

  it('returns nothing for no cookies', () => {
    expect(toSyncableFacebookCookies([])).toEqual([]);
  });
});
