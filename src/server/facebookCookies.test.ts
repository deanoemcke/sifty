import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initSchema } from './db';
import {
  getFacebookCookieStatus,
  getStoredFacebookCookiesJson,
  MissingFacebookCookiesError,
  parseFbCookies,
  resolveFacebookCookiesJson,
  saveFacebookCookies,
} from './facebookCookies';

function freshDb(): Database.Database {
  const database = new Database(':memory:');
  initSchema(database);
  return database;
}

const FUTURE_EXPIRY_SECONDS = Date.now() / 1000 + 30 * 24 * 60 * 60;

describe('facebook cookie store', () => {
  it('returns nothing when no cookies have been saved', () => {
    expect(getStoredFacebookCookiesJson(freshDb())).toBeUndefined();
  });

  it('returns the saved cookies on a later read', () => {
    const database = freshDb();
    const cookies = [
      { name: 'c_user', value: '12345', expirationDate: FUTURE_EXPIRY_SECONDS },
      { name: 'xs', value: 'secret', httpOnly: true },
    ];

    saveFacebookCookies(database, JSON.stringify(cookies));

    expect(JSON.parse(getStoredFacebookCookiesJson(database) ?? 'null')).toEqual(cookies);
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['an empty array', '[]'],
    [
      'only expired cookies',
      JSON.stringify([{ name: 'c_user', value: '1', expirationDate: 1000 }]),
    ],
  ])('rejects %s and keeps the previously saved cookies', (_description, badCookiesJson) => {
    const database = freshDb();
    const goodCookiesJson = JSON.stringify([{ name: 'c_user', value: 'good' }]);
    saveFacebookCookies(database, goodCookiesJson);

    expect(() => saveFacebookCookies(database, badCookiesJson)).toThrow(
      MissingFacebookCookiesError
    );
    expect(getStoredFacebookCookiesJson(database)).toBe(goodCookiesJson);
  });

  it('stores only the unexpired cookies', () => {
    const database = freshDb();

    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'expired', value: '1', expirationDate: 1000 },
        { name: 'fresh', value: '2' },
      ])
    );

    expect(JSON.parse(getStoredFacebookCookiesJson(database) ?? 'null')).toEqual([
      { name: 'fresh', value: '2' },
    ]);
  });

  it('rejects more than 200 cookies', () => {
    const tooManyCookies = Array.from({ length: 201 }, (_, index) => ({
      name: `cookie${index}`,
      value: 'x',
    }));

    expect(() => saveFacebookCookies(freshDb(), JSON.stringify(tooManyCookies))).toThrow(/200/);
  });

  it('rejects a cookie payload larger than 64 KiB', () => {
    const oversizedCookies = [{ name: 'c_user', value: 'x'.repeat(64 * 1024) }];

    expect(() => saveFacebookCookies(freshDb(), JSON.stringify(oversizedCookies))).toThrow(
      /64 KiB/
    );
  });
});

describe('resolveFacebookCookiesJson', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers cookies saved in the database over FB_COOKIES', () => {
    vi.stubEnv('FB_COOKIES', JSON.stringify([{ name: 'c_user', value: 'from-env' }]));
    const database = freshDb();
    saveFacebookCookies(database, JSON.stringify([{ name: 'c_user', value: 'from-database' }]));

    expect(resolveFacebookCookiesJson(database)).toContain('from-database');
  });

  it('falls back to FB_COOKIES when nothing has been saved', () => {
    vi.stubEnv('FB_COOKIES', JSON.stringify([{ name: 'c_user', value: 'from-env' }]));

    expect(resolveFacebookCookiesJson(freshDb())).toContain('from-env');
  });

  it('returns nothing when neither source has cookies', () => {
    vi.stubEnv('FB_COOKIES', undefined);

    expect(resolveFacebookCookiesJson(freshDb())).toBeUndefined();
  });
});

describe('getFacebookCookieStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports not synced when no cookies have been saved', () => {
    expect(getFacebookCookieStatus(freshDb())).toEqual({ isSynced: false });
  });

  it('reports when cookies were synced, how many, and when the login cookies expire', () => {
    vi.useFakeTimers({ now: new Date('2026-11-24T09:00:00Z') });
    const database = freshDb();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1', expirationDate: Date.parse('2027-02-14T00:00:00Z') / 1000 },
        { name: 'xs', value: '2', expires: Date.parse('2027-01-10T00:00:00Z') / 1000 },
        { name: 'wd', value: '3', expirationDate: Date.parse('2026-12-01T00:00:00Z') / 1000 },
        { name: 'presence', value: '4' },
      ])
    );

    // `wd` expires sooner than either login cookie but doesn't end the session.
    expect(getFacebookCookieStatus(database)).toEqual({
      isSynced: true,
      syncedAtMs: Date.parse('2026-11-24T09:00:00Z'),
      cookieCount: 4,
      loginExpiryMs: Date.parse('2027-01-10T00:00:00Z'),
    });
  });

  it('reports no login expiry when the login cookies are session cookies or missing', () => {
    const database = freshDb();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'xs', value: '2' },
        { name: 'wd', value: '3', expirationDate: Date.now() / 1000 + 3600 },
      ])
    );

    expect(getFacebookCookieStatus(database)).toMatchObject({ loginExpiryMs: null });
  });

  it('never includes cookie values', () => {
    const database = freshDb();
    saveFacebookCookies(
      database,
      JSON.stringify([{ name: 'xs', value: 'secret-session-value', httpOnly: true }])
    );

    expect(JSON.stringify(getFacebookCookieStatus(database))).not.toContain('secret-session-value');
  });
});

describe('parseFbCookies', () => {
  it('throws MissingFacebookCookiesError when FB_COOKIES is undefined', () => {
    expect(() => parseFbCookies(undefined)).toThrow(MissingFacebookCookiesError);
  });

  it('throws MissingFacebookCookiesError when FB_COOKIES is empty', () => {
    expect(() => parseFbCookies('')).toThrow(MissingFacebookCookiesError);
  });

  it('throws MissingFacebookCookiesError when FB_COOKIES is not valid JSON', () => {
    expect(() => parseFbCookies('{not json')).toThrow(MissingFacebookCookiesError);
  });

  it('throws MissingFacebookCookiesError when FB_COOKIES parses to an empty array', () => {
    expect(() => parseFbCookies('[]')).toThrow(MissingFacebookCookiesError);
  });

  it('throws MissingFacebookCookiesError when every cookie has expired', () => {
    const expired = JSON.stringify([
      { name: 'c_user', value: '1', expirationDate: 1000 },
      { name: 'xs', value: '2', expires: 2000 },
    ]);
    expect(() => parseFbCookies(expired)).toThrow(MissingFacebookCookiesError);
  });

  it('throws an error whose message tells the caller to set FB_COOKIES', () => {
    expect(() => parseFbCookies(undefined)).toThrow(/FB_COOKIES/);
  });

  it('returns the parsed cookies when FB_COOKIES is valid and unexpired', () => {
    const futureExpiry = Date.now() / 1000 + 3600;
    const cookies = parseFbCookies(
      JSON.stringify([{ name: 'c_user', value: '12345', expirationDate: futureExpiry }])
    );
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: 'c_user', value: '12345' });
  });

  it('returns cookies that have no expiry field at all', () => {
    const cookies = parseFbCookies(JSON.stringify([{ name: 'c_user', value: '12345' }]));
    expect(cookies).toHaveLength(1);
  });

  it('filters out only the expired cookies, keeping the rest', () => {
    const cookies = parseFbCookies(
      JSON.stringify([
        { name: 'expired', value: '1', expirationDate: 1000 },
        { name: 'fresh', value: '2' },
      ])
    );
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: 'fresh' });
  });
});
