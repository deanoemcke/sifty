import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendSignalNotificationAsync } from './notify';

describe('sendSignalNotificationAsync', () => {
  const originalToken = process.env.OPENCLAW_BEARER_TOKEN;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.OPENCLAW_BEARER_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.OPENCLAW_BEARER_TOKEN;
    else process.env.OPENCLAW_BEARER_TOKEN = originalToken;
    global.fetch = originalFetch;
  });

  it('throws a clear error when OPENCLAW_BEARER_TOKEN is not set', async () => {
    delete process.env.OPENCLAW_BEARER_TOKEN;
    await expect(sendSignalNotificationAsync('hello')).rejects.toThrow(/OPENCLAW_BEARER_TOKEN/);
  });

  it('POSTs to the OpenClaw notify endpoint with a bearer token and JSON message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendSignalNotificationAsync('new listing found');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8091/notify');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ message: 'new listing found' });
  });

  it('throws when the endpoint responds with a non-2xx status', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 500 })) as unknown as typeof fetch;

    await expect(sendSignalNotificationAsync('hello')).rejects.toThrow();
  });

  it('includes the image field in the body when an image option is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendSignalNotificationAsync('new listing found', {
      image: 'data:image/png;base64,abc',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      message: 'new listing found',
      image: 'data:image/png;base64,abc',
    });
  });
});
