import { describe, expect, it } from 'vitest';
import { describeQuickSearchProgress } from './quickSearchLogging';

describe('describeQuickSearchProgress', () => {
  it('describes the loading phase', () => {
    expect(describeQuickSearchProgress({ phase: 'loading' })).toBe('loading');
  });

  it('describes the counted phase', () => {
    expect(describeQuickSearchProgress({ phase: 'counted', totalResults: 42, totalPages: 3 })).toBe(
      '42 result(s) across 3 page(s)'
    );
  });

  it('describes the paging phase with a known total', () => {
    expect(describeQuickSearchProgress({ phase: 'paging', page: 2, totalPages: 3 })).toBe(
      'fetching page 2/3'
    );
  });

  it('describes the paging phase with an unknown total', () => {
    expect(describeQuickSearchProgress({ phase: 'paging', page: 2, totalPages: undefined })).toBe(
      'fetching page 2'
    );
  });

  it('describes the collecting phase', () => {
    expect(
      describeQuickSearchProgress({ phase: 'collecting', foundSoFar: 5, isLoadingMore: false })
    ).toBe('found 5 so far');
  });

  it('describes the collecting phase while still loading more', () => {
    expect(
      describeQuickSearchProgress({ phase: 'collecting', foundSoFar: 5, isLoadingMore: true })
    ).toBe('found 5 so far, loading more');
  });
});
