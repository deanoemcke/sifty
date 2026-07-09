import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderCooldownStore } from '../../lib/recipes/base';
import { aiJSON, getAIConfig } from '../ai';
import { clampRelevance, handleAiFilter, isValidFilterResultEntry } from './aiFilter';

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

function makeRequest(body: unknown): IncomingMessage {
  const stream = new PassThrough();
  stream.end(JSON.stringify(body));
  return stream as unknown as IncomingMessage;
}

function makeResponse(): ServerResponse & {
  events: unknown[];
  statusCode?: number;
  body?: string;
} {
  const events: unknown[] = [];
  const response = {
    events,
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk: string) => {
      const match = chunk.match(/^data: (.*)\n\n$/);
      if (match) events.push(JSON.parse(match[1]));
      return true;
    },
    end: (json?: string) => {
      if (json) response.body = json;
    },
    writeHead: (status: number) => {
      response.statusCode = status;
    },
  } as unknown as ServerResponse & { events: unknown[]; statusCode?: number; body?: string };
  return response;
}

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

describe('handleAiFilter', () => {
  it('returns 500 without starting the SSE stream when no AI provider is configured at all', async () => {
    vi.mocked(getAIConfig).mockImplementation(() => {
      throw new Error('GROQ_API_KEY is not set');
    });
    const request = makeRequest({
      listings: [makeListing('https://example.com/1')],
      prompt: 'laptop',
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('GROQ_API_KEY is not set');
    expect(vi.mocked(aiJSON)).not.toHaveBeenCalled();
  });

  it('re-resolves getAIConfig() fresh for each batch, so a mid-run provider rotation reaches later batches', async () => {
    const CONFIG_A = {
      url: 'a',
      model: 'm',
      apiKey: 'k',
      providerKey: 'a',
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    const CONFIG_B = {
      url: 'b',
      model: 'm',
      apiKey: 'k',
      providerKey: 'b',
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    vi.mocked(getAIConfig)
      .mockReturnValueOnce(CONFIG_A) // upfront fail-fast check
      .mockReturnValueOnce(CONFIG_A) // batch 1
      .mockReturnValueOnce(CONFIG_B); // batch 2 — rotated mid-run
    vi.mocked(aiJSON)
      .mockResolvedValueOnce({
        kind: 'ok',
        value: { results: [{ index: 1, pass: true, reason: null }] },
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        value: { results: [{ index: 1, pass: true, reason: null }] },
      });

    // BATCH_SIZE is 50 — 51 listings forces a second batch.
    const listings = Array.from({ length: 51 }, (_, i) => makeListing(`https://example.com/${i}`));
    const request = makeRequest({ listings, prompt: 'laptop' });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(vi.mocked(aiJSON).mock.calls).toHaveLength(2);
    expect(vi.mocked(aiJSON).mock.calls[0][0]).toBe(CONFIG_A);
    expect(vi.mocked(aiJSON).mock.calls[1][0]).toBe(CONFIG_B);
  });

  it("reports a per-batch error over SSE when a batch's AI call fails, without aborting the whole request", async () => {
    const CONFIG_A = {
      url: 'a',
      model: 'm',
      apiKey: 'k',
      providerKey: 'a',
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    vi.mocked(aiJSON).mockRejectedValueOnce(new Error('AI rate limited'));

    const request = makeRequest({
      listings: [makeListing('https://example.com/1')],
      prompt: 'laptop',
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.events).toContainEqual({ type: 'error', message: 'AI rate limited' });
  });

  it("marks the resolved config's cooldown store exhausted and reports the error over SSE when a batch is rate-limited", async () => {
    const markExhausted = vi.fn();
    const CONFIG_A = {
      url: 'a',
      model: 'm',
      apiKey: 'k',
      providerKey: 'a',
      cooldownStore: { markExhausted, getCooldownUntil: () => undefined },
    };
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    const cooldownUntilMs = Date.now() + 60_000;
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: 'rate-limited',
      providerKey: 'a',
      cooldownUntilMs,
      message: 'AI rate limited (ai-filter): provider asks to retry',
    });

    const request = makeRequest({
      listings: [makeListing('https://example.com/1')],
      prompt: 'laptop',
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.events).toContainEqual({
      type: 'error',
      message: 'AI rate limited (ai-filter): provider asks to retry',
    });
    expect(markExhausted).toHaveBeenCalledWith('a', cooldownUntilMs);
  });

  it('includes the AI-assigned relevance score in the SSE result', async () => {
    const CONFIG_A = {
      url: 'a',
      model: 'm',
      apiKey: 'k',
      providerKey: 'a',
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: 'ok',
      value: { results: [{ index: 1, pass: true, reason: null, relevance: 7 }] },
    });

    const request = makeRequest({
      listings: [makeListing('https://example.com/1')],
      prompt: 'laptop',
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.events).toContainEqual({
      type: 'result',
      results: [{ url: 'https://example.com/1', pass: true, reason: null, relevance: 7 }],
    });
  });

  it('clamps an out-of-range or missing relevance from the AI response rather than propagating it as-is', async () => {
    const CONFIG_A = {
      url: 'a',
      model: 'm',
      apiKey: 'k',
      providerKey: 'a',
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: 'ok',
      value: {
        results: [
          { index: 1, pass: true, reason: null, relevance: 99 },
          { index: 2, pass: false, reason: 'wrong type', relevance: undefined },
        ],
      },
    });

    const request = makeRequest({
      listings: [makeListing('https://example.com/1'), makeListing('https://example.com/2')],
      prompt: 'laptop',
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.events).toContainEqual({
      type: 'result',
      results: [
        { url: 'https://example.com/1', pass: true, reason: null, relevance: 9 },
        { url: 'https://example.com/2', pass: false, reason: 'wrong type', relevance: 0 },
      ],
    });
  });

  it('drops a result entry with a non-boolean pass instead of propagating it as-is', async () => {
    const CONFIG_A = {
      url: 'a',
      model: 'm',
      apiKey: 'k',
      providerKey: 'a',
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: 'ok',
      value: {
        results: [
          { index: 1, pass: 'yes', reason: null, relevance: 5 },
          { index: 2, pass: true, reason: null, relevance: 5 },
        ],
      },
    });

    const request = makeRequest({
      listings: [makeListing('https://example.com/1'), makeListing('https://example.com/2')],
      prompt: 'laptop',
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.events).toContainEqual({
      type: 'result',
      results: [{ url: 'https://example.com/2', pass: true, reason: null, relevance: 5 }],
    });
  });

  it('drops a result entry with a non-string, non-null reason instead of propagating it as-is', async () => {
    const CONFIG_A = {
      url: 'a',
      model: 'm',
      apiKey: 'k',
      providerKey: 'a',
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: 'ok',
      value: {
        results: [
          { index: 1, pass: false, reason: 42, relevance: 3 },
          { index: 2, pass: true, reason: null, relevance: 5 },
        ],
      },
    });

    const request = makeRequest({
      listings: [makeListing('https://example.com/1'), makeListing('https://example.com/2')],
      prompt: 'laptop',
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.events).toContainEqual({
      type: 'result',
      results: [{ url: 'https://example.com/2', pass: true, reason: null, relevance: 5 }],
    });
  });
});
