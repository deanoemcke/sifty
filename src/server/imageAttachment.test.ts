import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchListingImageAttachmentAsync,
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
} from './imageAttachment';

function jsonResponse(body: Uint8Array, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function streamingResponse(chunkBytes: number, chunkCount: number, contentType: string): Response {
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunkCount) {
        controller.close();
        return;
      }
      emitted++;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
}

describe('fetchListingImageAttachmentAsync', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('resolves undefined and makes no network call when no URL is given', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchListingImageAttachmentAsync(undefined);

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a base64 data URI for a small, allowed image', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(bytes, 'image/jpeg')) as unknown as typeof fetch;

    const result = await fetchListingImageAttachmentAsync('https://example.com/thumb.jpg');

    expect(result).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`);
  });

  it('rejects a disallowed content-type', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(new Uint8Array([1]), 'text/html')) as unknown as typeof fetch;

    const result = await fetchListingImageAttachmentAsync('https://example.com/thumb.jpg');

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('rejects a body exceeding MAX_IMAGE_BYTES without buffering it fully', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunkBytes = 1024 * 1024; // 1MB per chunk
    const chunkCount = Math.ceil(MAX_IMAGE_BYTES / chunkBytes) + 2; // guaranteed to exceed the cap
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        streamingResponse(chunkBytes, chunkCount, 'image/png')
      ) as unknown as typeof fetch;

    const result = await fetchListingImageAttachmentAsync('https://example.com/thumb.png');

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('resolves undefined on a non-ok HTTP status', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(new Uint8Array([1]), 'image/png', 404)
      ) as unknown as typeof fetch;

    const result = await fetchListingImageAttachmentAsync('https://example.com/missing.png');

    expect(result).toBeUndefined();
  });

  it('resolves undefined on a network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const result = await fetchListingImageAttachmentAsync('https://example.com/thumb.png');

    expect(result).toBeUndefined();
  });

  it('resolves undefined when the fetch is aborted for taking too long', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    ) as unknown as typeof fetch;

    const resultPromise = fetchListingImageAttachmentAsync('https://example.com/slow.png');
    await vi.advanceTimersByTimeAsync(IMAGE_FETCH_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result).toBeUndefined();
    vi.useRealTimers();
  });
});
