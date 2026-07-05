import { afterEach, describe, expect, it, vi } from "vitest";
import { streamPostAsync } from "./streamPost";

type MockResponseOptions = {
  ok?: boolean;
  status?: number;
  jsonBody?: unknown;
  jsonThrows?: boolean;
  chunks?: string[];
  hasBody?: boolean;
};

function mockFetchResponse(options: MockResponseOptions): void {
  const encoder = new TextEncoder();
  const pendingChunks = [...(options.chunks ?? [])];
  const reader = {
    read: async () =>
      pendingChunks.length > 0
        ? { value: encoder.encode(pendingChunks.shift()), done: false }
        : { value: undefined, done: true },
  };
  const response = {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => {
      if (options.jsonThrows) throw new Error("not json");
      return options.jsonBody;
    },
    body: (options.hasBody ?? true) ? { getReader: () => reader } : undefined,
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamPostAsync", () => {
  it("sends a JSON POST to the endpoint", async () => {
    mockFetchResponse({ chunks: [] });
    await streamPostAsync("/api/test", { key: "value" }, () => {});
    expect(fetch).toHaveBeenCalledWith("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    });
  });

  it("parses data: lines and passes each event to onData", async () => {
    mockFetchResponse({ chunks: ['data: {"a":1}\ndata: {"b":2}\n'] });
    const received: Record<string, unknown>[] = [];
    await streamPostAsync("/api/test", {}, (data) => received.push(data));
    expect(received).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reassembles events split across chunk boundaries", async () => {
    mockFetchResponse({ chunks: ['data: {"part', 'ial":true}\n', 'data: {"next":1}\n'] });
    const received: Record<string, unknown>[] = [];
    await streamPostAsync("/api/test", {}, (data) => received.push(data));
    expect(received).toEqual([{ partial: true }, { next: 1 }]);
  });

  it("ignores lines that are not data: events", async () => {
    mockFetchResponse({ chunks: [': comment\nevent: ping\ndata: {"ok":true}\n'] });
    const received: Record<string, unknown>[] = [];
    await streamPostAsync("/api/test", {}, (data) => received.push(data));
    expect(received).toEqual([{ ok: true }]);
  });

  it("silently skips malformed JSON events", async () => {
    mockFetchResponse({ chunks: ["data: not-json\n", 'data: {"good":1}\n'] });
    const received: Record<string, unknown>[] = [];
    await streamPostAsync("/api/test", {}, (data) => received.push(data));
    expect(received).toEqual([{ good: 1 }]);
  });

  it("throws the server error message on a non-ok response with a JSON body", async () => {
    mockFetchResponse({ ok: false, status: 400, jsonBody: { error: "bad prompt" } });
    await expect(streamPostAsync("/api/test", {}, () => {})).rejects.toThrow("bad prompt");
  });

  it("throws HTTP status when a non-ok response has no parseable body", async () => {
    mockFetchResponse({ ok: false, status: 502, jsonThrows: true });
    await expect(streamPostAsync("/api/test", {}, () => {})).rejects.toThrow("HTTP 502");
  });

  it("throws HTTP status when a non-ok JSON body has no error field", async () => {
    mockFetchResponse({ ok: false, status: 500, jsonBody: {} });
    await expect(streamPostAsync("/api/test", {}, () => {})).rejects.toThrow("HTTP 500");
  });

  it("throws when the response body is not readable", async () => {
    mockFetchResponse({ hasBody: false });
    await expect(streamPostAsync("/api/test", {}, () => {})).rejects.toThrow(
      "Response body is not readable",
    );
  });
});
