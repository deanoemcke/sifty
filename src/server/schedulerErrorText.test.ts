import { describe, expect, it } from 'vitest';
import { normalizeScrapeErrorReason } from './schedulerErrorText';

describe('normalizeScrapeErrorReason', () => {
  it('collapses reasons that differ only by an embedded count to the same key', () => {
    const a =
      'Login wall detected — only 3 listings loaded. Set the FB_COOKIES environment variable to get full results.';
    const b =
      'Login wall detected — only 47 listings loaded. Set the FB_COOKIES environment variable to get full results.';

    expect(normalizeScrapeErrorReason(a)).toBe(normalizeScrapeErrorReason(b));
  });

  it('collapses reasons that differ only by an embedded URL to the same key', () => {
    const a = 'Quick search for https://facebook.com/marketplace/search-a timed out after 30000ms';
    const b = 'Quick search for https://facebook.com/marketplace/search-b timed out after 30000ms';

    expect(normalizeScrapeErrorReason(a)).toBe(normalizeScrapeErrorReason(b));
  });

  it('does not collapse genuinely different failure categories', () => {
    const loginWall = 'Login wall detected — only 3 listings loaded.';
    const rateLimited = 'Rate limited by Facebook';

    expect(normalizeScrapeErrorReason(loginWall)).not.toBe(normalizeScrapeErrorReason(rateLimited));
  });
});
