import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTIVITY_CHECK_TIMEOUT_MS, checkInternetConnectivityAsync } from './connectivity';

describe('checkInternetConnectivityAsync', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('resolves true when the request reaches the network', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;

    await expect(checkInternetConnectivityAsync()).resolves.toBe(true);
  });

  it('resolves true even on a non-2xx response — reachability, not success, is what matters', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 })) as unknown as typeof fetch;

    await expect(checkInternetConnectivityAsync()).resolves.toBe(true);
  });

  it('resolves false on a network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    await expect(checkInternetConnectivityAsync()).resolves.toBe(false);
  });

  it('resolves false when the request is aborted for taking too long', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    ) as unknown as typeof fetch;

    const resultPromise = checkInternetConnectivityAsync();
    await vi.advanceTimersByTimeAsync(CONNECTIVITY_CHECK_TIMEOUT_MS);

    await expect(resultPromise).resolves.toBe(false);
  });

  it('sends a HEAD request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await checkInternetConnectivityAsync();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('HEAD');
  });
});
