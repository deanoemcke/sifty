import { describe, expect, it } from 'vitest';
import { MissingFacebookCookiesError, parseFbCookies } from './facebookCookies';

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
