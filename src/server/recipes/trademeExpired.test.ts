import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategoryLegacyPathRow } from '../db';
import { getDb, stmtGetCategoryByLegacyPath, stmtGetCategoryLegacyPath } from '../db';
import { resolveDiscoverCategoriesAsync } from './trademeCategoryResolver';
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
  stmtGetCategoryLegacyPath: vi.fn(),
  stmtGetCategoryByLegacyPath: vi.fn(),
}));
vi.mock('./trademeCategoryResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./trademeCategoryResolver')>();
  return { ...actual, resolveDiscoverCategoriesAsync: vi.fn() };
});

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
      get: (legacyPath: string) =>
        legacyPath === '0002-0356-'
          ? { slug: 'computers/laptops', display: 'Computers > Laptops' }
          : undefined,
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
      reserveStatus: 'MET',
      url: 'https://www.trademe.co.nz/computers/laptops/laptops/apple/listing-5967796300.htm?archive=1',
    });
    expect(listings[1]).toMatchObject({
      title: 'Macbook Pro 14-inch 2021 (M1 Pro, 32gb, 1tb)',
      price: 785,
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

describe('trademeExpiredRecipe.buildDiscoverUrlsAsync', () => {
  const STUB_COOLDOWN_STORE = { markExhausted: () => {}, getCooldownUntil: () => undefined };
  const MOCK_AI = {
    url: 'http://example.com',
    model: 'llama',
    apiKey: 'key',
    providerKey: 'mock',
    cooldownStore: STUB_COOLDOWN_STORE,
  };

  afterEach(() => vi.resetAllMocks());

  it('builds a legacy search URL for a resolved category slug', async () => {
    vi.mocked(getDb).mockReturnValue({} as unknown as Database.Database);
    vi.mocked(stmtGetCategoryLegacyPath).mockReturnValue({
      get: () => ({ legacy_path: '0002-0356-' }) as CategoryLegacyPathRow,
    } as unknown as ReturnType<typeof stmtGetCategoryLegacyPath>);
    vi.mocked(resolveDiscoverCategoriesAsync).mockResolvedValue({
      entries: [{ slug: 'computers/laptops', searchString: 'macbook pro' }],
      warnings: [],
    });

    const result = await trademeExpiredRecipe.buildDiscoverUrlsAsync('macbook pro', {
      maxPrice: 0,
      fulfillment: 'any',
      getAiConfig: () => MOCK_AI,
    });

    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain('cid=356');
    expect(result.urls[0]).toContain('rptpath=2-356-');
  });
});
