import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCooldownStore } from "../../lib/recipes/base";
import { aiJSON, getAIConfig } from "../ai";
import { handleAiFilter } from "./aiFilter";

// `applyAiJsonResult` is left as the real implementation (not mocked) so these tests
// exercise the actual orchestration logic — unwrapping an ok result, or marking the
// cooldown store and throwing for a rate-limited one — with only `aiJSON` and
// `getAIConfig` faked.
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
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
  return { url, title: "Item", price: "$10", location: "Auckland", description: "" };
}

describe("handleAiFilter", () => {
  it("returns 500 without starting the SSE stream when no AI provider is configured at all", async () => {
    vi.mocked(getAIConfig).mockImplementation(() => {
      throw new Error("GROQ_API_KEY is not set");
    });
    const request = makeRequest({
      listings: [makeListing("https://example.com/1")],
      prompt: "laptop",
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("GROQ_API_KEY is not set");
    expect(vi.mocked(aiJSON)).not.toHaveBeenCalled();
  });

  it("re-resolves getAIConfig() fresh for each batch, so a mid-run provider rotation reaches later batches", async () => {
    const CONFIG_A = {
      url: "a",
      model: "m",
      apiKey: "k",
      providerKey: "a",
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    const CONFIG_B = {
      url: "b",
      model: "m",
      apiKey: "k",
      providerKey: "b",
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    vi.mocked(getAIConfig)
      .mockReturnValueOnce(CONFIG_A) // upfront fail-fast check
      .mockReturnValueOnce(CONFIG_A) // batch 1
      .mockReturnValueOnce(CONFIG_B); // batch 2 — rotated mid-run
    vi.mocked(aiJSON)
      .mockResolvedValueOnce({
        kind: "ok",
        value: { results: [{ index: 1, pass: true, reason: null }] },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        value: { results: [{ index: 1, pass: true, reason: null }] },
      });

    // BATCH_SIZE is 50 — 51 listings forces a second batch.
    const listings = Array.from({ length: 51 }, (_, i) => makeListing(`https://example.com/${i}`));
    const request = makeRequest({ listings, prompt: "laptop" });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(vi.mocked(aiJSON).mock.calls).toHaveLength(2);
    expect(vi.mocked(aiJSON).mock.calls[0][0]).toBe(CONFIG_A);
    expect(vi.mocked(aiJSON).mock.calls[1][0]).toBe(CONFIG_B);
  });

  it("reports a per-batch error over SSE when a batch's AI call fails, without aborting the whole request", async () => {
    const CONFIG_A = {
      url: "a",
      model: "m",
      apiKey: "k",
      providerKey: "a",
      cooldownStore: STUB_COOLDOWN_STORE,
    };
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    vi.mocked(aiJSON).mockRejectedValueOnce(new Error("AI rate limited"));

    const request = makeRequest({
      listings: [makeListing("https://example.com/1")],
      prompt: "laptop",
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.events).toContainEqual({ type: "error", message: "AI rate limited" });
  });

  it("marks the resolved config's cooldown store exhausted and reports the error over SSE when a batch is rate-limited", async () => {
    const markExhausted = vi.fn();
    const CONFIG_A = {
      url: "a",
      model: "m",
      apiKey: "k",
      providerKey: "a",
      cooldownStore: { markExhausted, getCooldownUntil: () => undefined },
    };
    vi.mocked(getAIConfig).mockReturnValue(CONFIG_A);
    const cooldownUntilMs = Date.now() + 60_000;
    vi.mocked(aiJSON).mockResolvedValueOnce({
      kind: "rate-limited",
      providerKey: "a",
      cooldownUntilMs,
      message: "AI rate limited (ai-filter): provider asks to retry",
    });

    const request = makeRequest({
      listings: [makeListing("https://example.com/1")],
      prompt: "laptop",
    });
    const response = makeResponse();

    await handleAiFilter(request, response, STUB_COOLDOWN_STORE);

    expect(response.events).toContainEqual({
      type: "error",
      message: "AI rate limited (ai-filter): provider asks to retry",
    });
    expect(markExhausted).toHaveBeenCalledWith("a", cooldownUntilMs);
  });
});
