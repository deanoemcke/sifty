import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCooldownStore } from '../../lib/recipes/base';
import { aiJSON, getAIConfig } from '../ai';
import { clampRelevance, isValidFilterResultEntry, runAiFilterBatchesAsync } from './aiFilter';

// `applyAiJsonResult` is left as the real implementation (not mocked) so these tests
// exercise the actual orchestration logic — unwrapping an ok result, or marking the
// cooldown store and throwing for a rate-limited one — with only `aiJSON` and
// `getAIConfig` faked.
vi.mock('../ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai')>();
  return { ...actual, aiJSON: vi.fn(), getAIConfig: vi.fn() };
});

const STUB_COOLDOWN_STORE: ProviderCooldownStore = {
  markExhausted: () => {},
  getCooldownUntil: () => undefined,
};

// aiJSON/getAIConfig are shared mock instances across every test in this file —
// without a reset, one test's queued `mockResolvedValueOnce`/call history leaks
// into the next, making assertions on call count/order order-dependent.
beforeEach(() => {
  vi.mocked(aiJSON).mockReset();
  vi.mocked(getAIConfig).mockReset();
});

function makeListing(url: string) {
  return { url, title: 'Item', price: '$10', location: 'Auckland', description: '' };
}

describe('clampRelevance', () => {
  it('passes through an in-range integer', () => {
    expect(clampRelevance(7)).toBe(7);
    expect(clampRelevance(0)).toBe(0);
    expect(clampRelevance(9)).toBe(9);
  });

  it('clamps values above 9 down to 9', () => {
    expect(clampRelevance(42)).toBe(9);
  });

  it('clamps negative values up to 0', () => {
    expect(clampRelevance(-3)).toBe(0);
  });

  it('defaults non-integer values to 0', () => {
    expect(clampRelevance(3.5)).toBe(0);
  });

  it('defaults missing/non-numeric values to 0', () => {
    expect(clampRelevance(undefined)).toBe(0);
    expect(clampRelevance(null)).toBe(0);
    expect(clampRelevance('7')).toBe(0);
  });
});

describe('isValidFilterResultEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(isValidFilterResultEntry({ index: 1, pass: true, reason: null })).toBe(true);
    expect(isValidFilterResultEntry({ index: 1, pass: false, reason: 'wrong type' })).toBe(true);
  });

  it('accepts a missing reason', () => {
    expect(isValidFilterResultEntry({ index: 1, pass: true })).toBe(true);
  });

  it('rejects a non-boolean pass', () => {
    expect(isValidFilterResultEntry({ index: 1, pass: 'yes', reason: null })).toBe(false);
    expect(isValidFilterResultEntry({ index: 1, pass: 1, reason: null })).toBe(false);
    expect(isValidFilterResultEntry({ index: 1, reason: null })).toBe(false);
  });

  it('rejects a reason that is neither a string nor null/undefined', () => {
    expect(isValidFilterResultEntry({ index: 1, pass: true, reason: 42 })).toBe(false);
    expect(isValidFilterResultEntry({ index: 1, pass: true, reason: { text: 'no' } })).toBe(false);
  });

  it('rejects a non-numeric index', () => {
    expect(isValidFilterResultEntry({ index: '1', pass: true, reason: null })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isValidFilterResultEntry(null)).toBe(false);
    expect(isValidFilterResultEntry(undefined)).toBe(false);
    expect(isValidFilterResultEntry('nope')).toBe(false);
  });
});

describe('runAiFilterBatchesAsync', () => {
  const CONFIG_A = {
    url: 'a',
    model: 'm',
    apiKey: 'k',
    providerKey: 'a',
    cooldownStore: STUB_COOLDOWN_STORE,
  };

  it('returns the flattened results without any callback', async () => {
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: 'ok',
      value: { results: [{ index: 1, pass: true, reason: null, relevance: 7 }] },
    });

    const results = await runAiFilterBatchesAsync(
      [makeListing('https://example.com/1')],
      'laptop',
      STUB_COOLDOWN_STORE
    );

    expect(results).toEqual([
      { url: 'https://example.com/1', pass: true, reason: null, relevance: 7 },
    ]);
  });

  it('invokes onBatchResult per completed batch', async () => {
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: 'ok',
      value: { results: [{ index: 1, pass: true, reason: null, relevance: 7 }] },
    });
    const onBatchResult = vi.fn();

    await runAiFilterBatchesAsync(
      [makeListing('https://example.com/1')],
      'laptop',
      STUB_COOLDOWN_STORE,
      onBatchResult
    );

    expect(onBatchResult).toHaveBeenCalledWith([
      { url: 'https://example.com/1', pass: true, reason: null, relevance: 7 },
    ]);
  });

  it('invokes onBatchError for a failed batch instead of throwing, and does not abort other batches', async () => {
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    vi.mocked(aiJSON)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        kind: 'ok',
        value: { results: [{ index: 1, pass: true, reason: null, relevance: 7 }] },
      });
    const onBatchError = vi.fn();

    // BATCH_SIZE is 50 — 51 listings forces a second batch.
    const listings = Array.from({ length: 51 }, (_, i) => makeListing(`https://example.com/${i}`));
    const results = await runAiFilterBatchesAsync(
      listings,
      'laptop',
      STUB_COOLDOWN_STORE,
      undefined,
      onBatchError
    );

    expect(onBatchError).toHaveBeenCalledWith('boom');
    expect(results).toHaveLength(1);
  });
});
