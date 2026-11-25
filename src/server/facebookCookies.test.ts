import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getFacebookCookieStatus,
  getStoredFacebookCookiesJson,
  InvalidFacebookCookiePayloadError,
  loadFacebookCookies,
  MissingFacebookCookiesError,
  parseFbCookies,
  saveFacebookCookies,
} from './facebookCookies';
import { createFreshDatabase } from './testDatabase';

const FUTURE_EXPIRY_SECONDS = Date.now() / 1000 + 30 * 24 * 60 * 60;

describe('facebook cookie store', () => {
  it('returns nothing when no cookies have been saved', () => {
    expect(getStoredFacebookCookiesJson(createFreshDatabase())).toBeUndefined();
  });

  it('returns the saved cookies on a later read', () => {
    const database = createFreshDatabase();
    const cookies = [
      { name: 'c_user', value: '12345', expirationDate: FUTURE_EXPIRY_SECONDS },
      { name: 'xs', value: 'secret', httpOnly: true },
    ];

    saveFacebookCookies(database, JSON.stringify(cookies));

    expect(JSON.parse(getStoredFacebookCookiesJson(database) ?? 'null')).toEqual(cookies);
  });

  it.each([
    ['malformed JSON', '{not json', InvalidFacebookCookiePayloadError],
    ['an empty array', '[]', InvalidFacebookCookiePayloadError],
    ['a non-array', '{"name":"c_user"}', InvalidFacebookCookiePayloadError],
    [
      'only expired cookies',
      JSON.stringify([{ name: 'c_user', value: '1', expirationDate: 1000 }]),
      MissingFacebookCookiesError,
    ],
  ])('rejects %s and keeps the previously saved cookies', (_description, badCookiesJson, errorClass) => {
    const database = createFreshDatabase();
    const goodCookiesJson = JSON.stringify([
      { name: 'c_user', value: 'good' },
      { name: 'xs', value: 'good' },
    ]);
    saveFacebookCookies(database, goodCookiesJson);

    expect(() => saveFacebookCookies(database, badCookiesJson)).toThrow(errorClass);
    expect(getStoredFacebookCookiesJson(database)).toBe(goodCookiesJson);
  });

  it.each([
    '[null]',
    '[1]',
    '["a"]',
    '[{}]',
    '[{"name":1}]',
    '[{"name":"c_user"}]',
  ])('rejects the malformed cookie elements %s and keeps the previously saved cookies', (malformedCookiesJson) => {
    const database = createFreshDatabase();
    const goodCookiesJson = JSON.stringify([
      { name: 'c_user', value: '1' },
      { name: 'xs', value: '2' },
    ]);
    saveFacebookCookies(database, goodCookiesJson);

    expect(() => saveFacebookCookies(database, malformedCookiesJson)).toThrow(
      InvalidFacebookCookiePayloadError
    );
    expect(getStoredFacebookCookiesJson(database)).toBe(goodCookiesJson);
  });

  it.each([
    ['no login cookies', [{ name: 'datr', value: 'x' }]],
    ['only the xs login cookie', [{ name: 'xs', value: '2' }]],
    ['only the c_user login cookie', [{ name: 'c_user', value: '1' }]],
    [
      'only expired login cookies',
      [
        { name: 'c_user', value: '1', expirationDate: 1000 },
        { name: 'xs', value: '2', expirationDate: 1000 },
        { name: 'datr', value: 'x' },
      ],
    ],
  ])('rejects a set with %s as a logout and keeps the previously saved cookies', (_description, loggedOutCookies) => {
    const database = createFreshDatabase();
    const goodCookiesJson = JSON.stringify([
      { name: 'c_user', value: '1' },
      { name: 'xs', value: '2' },
    ]);
    saveFacebookCookies(database, goodCookiesJson);

    expect(() => saveFacebookCookies(database, JSON.stringify(loggedOutCookies))).toThrow(
      MissingFacebookCookiesError
    );
    expect(getStoredFacebookCookiesJson(database)).toBe(goodCookiesJson);
  });

  it('reports a rejected sync payload without asking the user to log in', () => {
    expect(() => saveFacebookCookies(createFreshDatabase(), '{not json')).not.toThrow(/log in/i);
  });

  it('stores only the unexpired cookies', () => {
    const database = createFreshDatabase();

    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'expired', value: '1', expirationDate: 1000 },
        { name: 'c_user', value: '2' },
        { name: 'xs', value: '3' },
      ])
    );

    expect(JSON.parse(getStoredFacebookCookiesJson(database) ?? 'null')).toEqual([
      { name: 'c_user', value: '2' },
      { name: 'xs', value: '3' },
    ]);
  });

  it('rejects more than 200 cookies', () => {
    const tooManyCookies = Array.from({ length: 201 }, (_, index) => ({
      name: `cookie${index}`,
      value: 'x',
    }));

    expect(() =>
      saveFacebookCookies(createFreshDatabase(), JSON.stringify(tooManyCookies))
    ).toThrow(InvalidFacebookCookiePayloadError);
    expect(() =>
      saveFacebookCookies(createFreshDatabase(), JSON.stringify(tooManyCookies))
    ).toThrow(/200/);
  });

  it('applies the cookie count cap to the payload, not to what survives the expiry filter', () => {
    const cookies = Array.from({ length: 250 }, (_, index) => ({
      name: index === 0 ? 'c_user' : `cookie${index}`,
      value: 'x',
      ...(index >= 190 ? { expirationDate: 1000 } : {}),
    }));

    expect(() => saveFacebookCookies(createFreshDatabase(), JSON.stringify(cookies))).toThrow(
      InvalidFacebookCookiePayloadError
    );
  });

  it('rejects a cookie payload larger than 64 KiB', () => {
    const oversizedCookies = [{ name: 'c_user', value: 'x'.repeat(64 * 1024) }];

    expect(() =>
      saveFacebookCookies(createFreshDatabase(), JSON.stringify(oversizedCookies))
    ).toThrow(InvalidFacebookCookiePayloadError);
    expect(() =>
      saveFacebookCookies(createFreshDatabase(), JSON.stringify(oversizedCookies))
    ).toThrow(/64 KiB/);
  });
});

describe('getFacebookCookieStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports not synced when no cookies have been saved', () => {
    expect(getFacebookCookieStatus(createFreshDatabase())).toEqual({ isSynced: false });
  });

  it('reports when cookies were synced, how many, and when the login cookies expire', () => {
    vi.useFakeTimers({ now: new Date('2026-11-24T09:00:00Z') });
    const database = createFreshDatabase();
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
      isLoginUsable: true,
      cookieCount: 4,
      loginExpiryMs: Date.parse('2027-01-10T00:00:00Z'),
    });
  });

  it('reports no login expiry when the login cookies are session cookies', () => {
    const database = createFreshDatabase();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1' },
        { name: 'xs', value: '2' },
        { name: 'wd', value: '3', expirationDate: Date.now() / 1000 + 3600 },
      ])
    );

    expect(getFacebookCookieStatus(database)).toMatchObject({
      isLoginUsable: true,
      loginExpiryMs: null,
    });
  });

  it('reports no login expiry when only some login cookies are session cookies, since the session end is unknown', () => {
    const database = createFreshDatabase();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1', expirationDate: Date.now() / 1000 + 3600 },
        { name: 'xs', value: '2' },
      ])
    );

    expect(getFacebookCookieStatus(database)).toMatchObject({
      isLoginUsable: true,
      loginExpiryMs: null,
    });
  });

  it('reports an unusable login once the stored cookies have expired, matching what loading would do', () => {
    vi.useFakeTimers({ now: new Date('2026-11-24T09:00:00Z') });
    const database = createFreshDatabase();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1', expirationDate: Date.parse('2026-11-24T10:00:00Z') / 1000 },
        { name: 'xs', value: '2', expirationDate: Date.parse('2026-11-24T10:00:00Z') / 1000 },
      ])
    );
    vi.setSystemTime(new Date('2026-11-24T11:00:00Z'));

    expect(() => loadFacebookCookies(database)).toThrow(MissingFacebookCookiesError);
    expect(getFacebookCookieStatus(database)).toMatchObject({
      isSynced: true,
      isLoginUsable: false,
      syncedAtMs: Date.parse('2026-11-24T09:00:00Z'),
      unusableReason: expect.stringContaining('expired'),
    });
  });

  it('counts only unexpired cookies and ignores an expired login cookie when reporting the expiry', () => {
    vi.useFakeTimers({ now: new Date('2026-11-24T09:00:00Z') });
    const database = createFreshDatabase();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1', expirationDate: Date.parse('2027-02-14T00:00:00Z') / 1000 },
        { name: 'xs', value: '2', expirationDate: Date.parse('2027-01-10T00:00:00Z') / 1000 },
        { name: 'wd', value: '3', expirationDate: Date.parse('2026-11-24T10:00:00Z') / 1000 },
      ])
    );
    vi.setSystemTime(new Date('2026-11-24T11:00:00Z'));

    expect(getFacebookCookieStatus(database)).toMatchObject({
      isLoginUsable: true,
      cookieCount: 2,
      loginExpiryMs: Date.parse('2027-01-10T00:00:00Z'),
    });
  });

  it('reports an unusable login when only non-login cookies remain unexpired', () => {
    vi.useFakeTimers({ now: new Date('2026-11-24T09:00:00Z') });
    const database = createFreshDatabase();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1', expirationDate: Date.parse('2026-11-24T10:00:00Z') / 1000 },
        { name: 'xs', value: '2', expirationDate: Date.parse('2026-11-24T10:00:00Z') / 1000 },
        { name: 'wd', value: '3' },
      ])
    );
    vi.setSystemTime(new Date('2026-11-24T11:00:00Z'));

    expect(() => loadFacebookCookies(database)).toThrow(MissingFacebookCookiesError);
    expect(getFacebookCookieStatus(database)).toMatchObject({
      isSynced: true,
      isLoginUsable: false,
    });
  });

  it('reports an unusable login, and refuses to load, when a stored set holds only one login cookie', () => {
    const database = createFreshDatabase();
    database
      .prepare('INSERT INTO facebook_cookies (id, cookies_json, synced_at) VALUES (1, ?, ?)')
      .run(JSON.stringify([{ name: 'xs', value: '2' }]), 1);

    expect(() => loadFacebookCookies(database)).toThrow(MissingFacebookCookiesError);
    expect(getFacebookCookieStatus(database)).toMatchObject({
      isSynced: true,
      isLoginUsable: false,
    });
  });

  it('reports an unusable login, rather than throwing, when the stored cookies are corrupt', () => {
    const database = createFreshDatabase();
    database
      .prepare('INSERT INTO facebook_cookies (id, cookies_json, synced_at) VALUES (1, ?, ?)')
      .run('oops', 1);

    expect(getFacebookCookieStatus(database)).toMatchObject({
      isSynced: true,
      isLoginUsable: false,
      syncedAtMs: 1,
    });
  });

  it('never includes cookie values', () => {
    const database = createFreshDatabase();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1' },
        { name: 'xs', value: 'secret-session-value', httpOnly: true },
      ])
    );

    expect(JSON.stringify(getFacebookCookieStatus(database))).not.toContain('secret-session-value');
  });
});

describe('parseFbCookies', () => {
  it.each([
    ['no cookies are given', undefined],
    ['the cookies are empty', ''],
    ['the cookies are not valid JSON', '{not json'],
    ['an element is not a cookie', '[null]'],
    ['the cookies parse to an empty array', '[]'],
    [
      'every cookie has expired',
      JSON.stringify([
        { name: 'c_user', value: '1', expirationDate: 1000 },
        { name: 'xs', value: '2', expires: 2000 },
      ]),
    ],
  ])('throws MissingFacebookCookiesError when %s', (_description, rawCookies) => {
    expect(() => parseFbCookies(rawCookies)).toThrow(MissingFacebookCookiesError);
  });

  it('throws an error that tells the user to log in to Facebook in Chrome, not to set an environment variable', () => {
    expect(() => parseFbCookies(undefined)).toThrow(/log in to Facebook in Chrome/i);
    expect(() => parseFbCookies(undefined)).not.toThrow(/FB_COOKIES/);
  });

  it('returns the parsed cookies when the cookies are valid and unexpired', () => {
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
