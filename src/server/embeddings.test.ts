import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cosineSimilarity, embedTextAsync, embedTextsBatchAsync } from './embeddings';

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function make429Response(retryDelay: string | null): Response {
  const body = retryDelay
    ? {
        error: {
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }],
        },
      }
    : { error: {} };
  return makeResponse(429, body);
}

function makeDailyQuotaExhaustedResponse(): Response {
  return makeResponse(429, {
    error: {
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier' }],
        },
      ],
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1);
  });

  it('returns 0 when either vector is all zeros', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('throws on a dimension mismatch instead of silently producing NaN', () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(/dimension mismatch/);
  });
});

describe('embedTextAsync', () => {
  it('throws immediately when GEMINI_API_KEY is unset', async () => {
    vi.stubEnv('GEMINI_API_KEY', undefined);
    await expect(embedTextAsync('ladder')).rejects.toThrow('GEMINI_API_KEY is not set');
  });

  it('returns the embedding values from a successful response', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(200, { embedding: { values: [0.1, 0.2, 0.3] } }));

    const result = await embedTextAsync('ladder');

    expect(result).toEqual([0.1, 0.2, 0.3]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(':embedContent');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
  });

  it('throws on a non-ok response', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('rate limited', { status: 429 })
    );
    await expect(embedTextAsync('ladder')).rejects.toThrow('Gemini embedContent failed [429]');
  });

  it('throws on a malformed 200 response missing embedding.values', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse(200, {}));
    await expect(embedTextAsync('ladder')).rejects.toThrow('malformed response');
  });
});

describe('embedTextsBatchAsync', () => {
  it('throws immediately when GEMINI_API_KEY is unset', async () => {
    vi.stubEnv('GEMINI_API_KEY', undefined);
    await expect(embedTextsBatchAsync(['ladder'])).rejects.toThrow('GEMINI_API_KEY is not set');
  });

  it('returns one embedding per input text, in order', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeResponse(200, { embeddings: [{ values: [1, 0] }, { values: [0, 1] }] })
    );

    const result = await embedTextsBatchAsync(['ladder', 'scaffolding']);

    expect(result).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('chunks requests larger than the per-request cap into multiple calls', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const texts = Array.from({ length: 150 }, (_, i) => `category ${i}`);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeResponse(200, { embeddings: Array.from({ length: 100 }, () => ({ values: [1] })) })
      )
      .mockResolvedValueOnce(
        makeResponse(200, { embeddings: Array.from({ length: 50 }, () => ({ values: [2] })) })
      );

    const result = await embedTextsBatchAsync(texts);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(150);
  });

  it('throws when the response embeddings count does not match the request count', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeResponse(200, { embeddings: [{ values: [1, 0] }] })
    );
    await expect(embedTextsBatchAsync(['ladder', 'scaffolding'])).rejects.toThrow(
      'embeddings count mismatch'
    );
  });

  describe('429 retry (Gemini free-tier per-minute quota)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries after Gemini's reported retryDelay and succeeds", async () => {
      vi.stubEnv('GEMINI_API_KEY', 'test-key');
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(make429Response('5s'))
        .mockResolvedValueOnce(makeResponse(200, { embeddings: [{ values: [1, 0] }] }));

      const promise = embedTextsBatchAsync(['ladder']);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual([[1, 0]]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to a default delay when no retryDelay is reported, and still retries', async () => {
      vi.stubEnv('GEMINI_API_KEY', 'test-key');
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(make429Response(null))
        .mockResolvedValueOnce(makeResponse(200, { embeddings: [{ values: [1, 0] }] }));

      const promise = embedTextsBatchAsync(['ladder']);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual([[1, 0]]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting retries on persistent 429s', async () => {
      vi.stubEnv('GEMINI_API_KEY', 'test-key');
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(make429Response('1s'));

      const promise = embedTextsBatchAsync(['ladder']);
      const assertion = expect(promise).rejects.toThrow('Gemini batchEmbedContents failed [429]');
      await vi.runAllTimersAsync();
      await assertion;

      // 1 initial attempt + 10 retries.
      expect(fetchMock).toHaveBeenCalledTimes(11);
    });

    it('fails fast without retrying when the daily free-tier quota is exhausted', async () => {
      vi.stubEnv('GEMINI_API_KEY', 'test-key');
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(makeDailyQuotaExhaustedResponse());

      const promise = embedTextsBatchAsync(['ladder']);
      const assertion = expect(promise).rejects.toThrow('daily free-tier quota exhausted');
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
