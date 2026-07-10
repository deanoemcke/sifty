import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing } from '../../lib/recipes/base';
import { MAX_RESULTS_PER_URL } from '../constants';
import { getDb, stmtGetCategoryByLegacyPath } from '../db';
import {
  buildLegacySearchUrl,
  deriveLegacyCidAndRptpath,
  extractImplicitFilters,
  parseLegacySearchResultsHtml,
  reconstructLegacyPathFromRptpath,
  trademeExpiredRecipe,
} from './trademeExpired';

vi.mock('../db', () => ({
  getDb: vi.fn(),
  stmtGetCategoryByLegacyPath: vi.fn(),
}));

// ── Playwright mock for quickSearch integration tests ─────────────────────────
// trademeExpired's quickSearchAsync reuses a single Page across all page
// navigations (unlike trademe.ts, which opens one Page per page number), so the
// mock queues HTML strings returned by successive `page.content()` calls rather
// than queuing whole Page objects.

const { queueLegacyPages, shiftLegacyPage } = vi.hoisted(() => {
  const htmlQueue: string[] = [];
  return {
    queueLegacyPages: (...htmlPages: string[]) => {
      htmlQueue.splice(0, htmlQueue.length, ...htmlPages);
    },
    shiftLegacyPage: () => htmlQueue.shift() ?? '<html><body></body></html>',
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          content: async () => shiftLegacyPage(),
        }),
      }),
      close: async () => {},
    }),
  },
}));

const FIXTURE_HTML = fs.readFileSync(
  path.join(__dirname, '__fixtures__/trademe-legacy-search.html'),
  'utf8'
);

describe('deriveLegacyCidAndRptpath', () => {
  it('derives cid and rptpath for a depth-2 category', () => {
    expect(deriveLegacyCidAndRptpath('0002-0356-')).toEqual({ cid: '356', rptpath: '2-356-' });
  });

  it('derives cid and rptpath for a deeper category', () => {
    expect(deriveLegacyCidAndRptpath('0002-0356-0032-2273-')).toEqual({
      cid: '2273',
      rptpath: '2-356-32-2273-',
    });
  });

  it('derives cid and rptpath for a single-segment top-level category', () => {
    expect(deriveLegacyCidAndRptpath('0001-')).toEqual({ cid: '1', rptpath: '1-' });
  });
});

describe('reconstructLegacyPathFromRptpath', () => {
  it('is the inverse of the rptpath half of deriveLegacyCidAndRptpath', () => {
    expect(reconstructLegacyPathFromRptpath('2-356-')).toBe('0002-0356-');
    expect(reconstructLegacyPathFromRptpath('2-356-32-2273-')).toBe('0002-0356-0032-2273-');
  });
});

describe('buildLegacySearchUrl', () => {
  it('builds a URL with the hardcoded sold-only params', () => {
    const url = buildLegacySearchUrl(
      { slug: 'computers/laptops', searchString: 'macbook pro' },
      '0002-0356-'
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://www.trademe.co.nz/Browse/SearchResults.aspx'
    );
    expect(parsed.searchParams.get('cid')).toBe('356');
    expect(parsed.searchParams.get('rptpath')).toBe('2-356-');
    expect(parsed.searchParams.get('current')).toBe('0');
    expect(parsed.searchParams.get('sort_order')).toBe('bids_asc');
    expect(parsed.searchParams.get('searchregion')).toBe('100');
    expect(parsed.searchParams.get('advanced')).toBe('true');
    expect(parsed.searchParams.get('from')).toBe('advanced');
    expect(parsed.searchParams.get('searchstring')).toBe('macbook pro');
  });

  it('omits searchstring when entry.searchString is null', () => {
    const url = buildLegacySearchUrl(
      { slug: 'computers/laptops', searchString: null },
      '0002-0356-'
    );
    expect(new URL(url).searchParams.has('searchstring')).toBe(false);
  });
});

describe('extractImplicitFilters', () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue({} as unknown as Database.Database);
    vi.mocked(stmtGetCategoryByLegacyPath).mockReturnValue({
      get: (legacyPath: string) => {
        if (legacyPath === '0002-0356-') {
          return { slug: 'computers/laptops', display: 'Computers > Laptops' };
        }
        if (legacyPath === '0002-0356-0032-2273-') {
          return {
            slug: 'computers/laptops/apple/macbook',
            display: 'Computers > Laptops > Apple > MacBook',
          };
        }
        return undefined;
      },
    } as unknown as ReturnType<typeof stmtGetCategoryByLegacyPath>);
  });

  afterEach(() => vi.resetAllMocks());

  it('extracts the search term', () => {
    const filters = extractImplicitFilters(
      'https://www.trademe.co.nz/Browse/SearchResults.aspx?searchstring=macbook+pro&cid=356&rptpath=2-356-'
    );
    expect(filters).toContainEqual(['Search', 'macbook pro']);
  });

  it('resolves the category display name from rptpath', () => {
    const filters = extractImplicitFilters(
      'https://www.trademe.co.nz/Browse/SearchResults.aspx?searchstring=macbook+pro&cid=356&rptpath=2-356-'
    );
    expect(filters).toContainEqual(['Category', 'Computers > Laptops']);
  });

  it('omits the hardcoded/forced params from the filter list', () => {
    const filters = extractImplicitFilters(
      'https://www.trademe.co.nz/Browse/SearchResults.aspx?searchstring=macbook+pro&cid=356&rptpath=2-356-&current=0&sort_order=bids_asc&searchregion=100&advanced=true&from=advanced'
    );
    const keys = filters.map(([key]) => key);
    expect(keys).not.toContain('current');
    expect(keys).not.toContain('sort_order');
    expect(keys).not.toContain('searchregion');
    expect(keys).not.toContain('advanced');
    expect(keys).not.toContain('from');
  });

  it('returns an empty array for a malformed URL', () => {
    expect(extractImplicitFilters('not-a-url')).toEqual([]);
  });

  it('puts Category before Search, matching trademe.ts ordering', () => {
    const filters = extractImplicitFilters(
      'https://www.trademe.co.nz/Browse/SearchResults.aspx?searchstring=macbook+pro&cid=356&rptpath=2-356-'
    );
    const keys = filters.map(([key]) => key);
    expect(keys.indexOf('Category')).toBeLessThan(keys.indexOf('Search'));
  });

  it('shows only the last two breadcrumb sections of the category', () => {
    const filters = extractImplicitFilters(
      'https://www.trademe.co.nz/Browse/SearchResults.aspx?cid=2273&rptpath=2-356-32-2273-'
    );
    expect(filters).toContainEqual(['Category', 'Apple > MacBook']);
  });

  it('always includes Availability: SOLD, since this recipe only ever searches closed listings', () => {
    const filters = extractImplicitFilters(
      'https://www.trademe.co.nz/Browse/SearchResults.aspx?searchstring=macbook+pro&cid=356&rptpath=2-356-'
    );
    expect(filters).toContainEqual(['Availability', 'SOLD']);
  });
});

describe('trademeExpiredRecipe.matches', () => {
  it('accepts a legacy Browse/SearchResults.aspx URL', () => {
    expect(
      trademeExpiredRecipe.matches('https://www.trademe.co.nz/Browse/SearchResults.aspx?cid=356')
    ).toBe(true);
  });

  it('rejects a modern /a/marketplace URL', () => {
    expect(
      trademeExpiredRecipe.matches(
        'https://www.trademe.co.nz/a/marketplace/computers/laptops/search'
      )
    ).toBe(false);
  });

  it('rejects a non-trademe hostname', () => {
    expect(
      trademeExpiredRecipe.matches('https://www.example.com/Browse/SearchResults.aspx?cid=356')
    ).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(trademeExpiredRecipe.matches('not-a-url')).toBe(false);
  });
});

describe('parseLegacySearchResultsHtml', () => {
  it('parses each listing card into a Listing', () => {
    const { listings } = parseLegacySearchResultsHtml(FIXTURE_HTML);
    expect(listings).toHaveLength(2); // third card in the fixture has 0 bids — excluded
    expect(listings[0]).toMatchObject({
      title: 'MacBook Pro 15” (2018) | i7 | 16GB RAM | Radeon Pro 555X - For Parts (Faulty)',
      price: 212,
      location: 'Auckland City, Auckland, NZ',
      isAuction: true,
      isSold: true,
      reserveStatus: 'MET',
      url: 'https://www.trademe.co.nz/computers/laptops/laptops/apple/listing-5967796300.htm?archive=1',
    });
    expect(listings[1]).toMatchObject({
      title: 'Macbook Pro 14-inch 2021 (M1 Pro, 32gb, 1tb)',
      price: 785,
      isSold: false,
      reserveStatus: 'NOT_MET',
    });
  });

  it('stops at the first zero-bid card and reports reachedZeroBids', () => {
    const { listings, reachedZeroBids } = parseLegacySearchResultsHtml(FIXTURE_HTML);
    expect(reachedZeroBids).toBe(true);
    expect(listings.some((l) => l.title.includes('4x2017'))).toBe(false);
  });

  it('reports reachedZeroBids false and no listings for a page with no cards', () => {
    const { listings, reachedZeroBids } = parseLegacySearchResultsHtml('<ul></ul>');
    expect(listings).toEqual([]);
    expect(reachedZeroBids).toBe(false);
  });
});

// ── quickSearch MAX_RESULTS_PER_URL cap ───────────────────────────────────────

function makeLegacyCard(index: number): string {
  return `
    <div class="listingCard">
      <div class="listingNumberOfBidsText">1 bid</div>
      <div class="listingTitle"><a href="/listing-${index}.htm">Item ${index}</a></div>
      <div class="listingBidPrice">$${index}</div>
      <div class="listingLocation">Auckland</div>
    </div>`;
}

function makeLegacyPageHtml(cardIndexes: number[]): string {
  return `<html><body><ul>${cardIndexes.map(makeLegacyCard).join('')}</ul></body></html>`;
}

describe('quickSearchAsync MAX_RESULTS_PER_URL cap', () => {
  it('never emits more than MAX_RESULTS_PER_URL listings for a single URL, even with more pages left', async () => {
    const cardsPerPage = 60;
    // 3 pages of non-zero-bid cards (never reaching zero bids) — 180 listings total,
    // well beyond MAX_RESULTS_PER_URL (100), so the cap must kick in before the
    // legacy scraper's own MAX_PAGES_PER_SEARCH (20) pagination limit would.
    const pages = Array.from({ length: 3 }, (_, pageIndex) =>
      makeLegacyPageHtml(
        Array.from({ length: cardsPerPage }, (_, i) => pageIndex * cardsPerPage + i + 1)
      )
    );
    queueLegacyPages(...pages);

    const collected: Listing[] = [];
    await trademeExpiredRecipe.quickSearchAsync(
      'https://www.trademe.co.nz/Browse/SearchResults.aspx?cid=356',
      (ev) => {
        if (ev.type === 'listing') collected.push(ev.data);
      }
    );

    expect(collected).toHaveLength(MAX_RESULTS_PER_URL);
  });
});
