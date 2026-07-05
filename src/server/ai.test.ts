import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "./ai";
import { aiJSON, MAX_RETRIES, TOTAL_TIMEOUT_MS } from "./ai";

const MOCK_CONFIG: AiConfig = {
  url: "https://api.example.com/chat",
  model: "test-model",
  apiKey: "test-key",
};

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeSuccessResponse(result: unknown): Response {
  return makeResponse(200, { choices: [{ message: { content: JSON.stringify(result) } }] });
}

function make429Response(
  retryAfter: number,
  message = "Rate limit reached. Please try again in 6s.",
): Response {
  return makeResponse(429, { error: { message } }, { "retry-after": String(retryAfter) });
}

describe("aiJSON", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries on 429 and returns the successful result", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(make429Response(0.01))
      .mockResolvedValueOnce(makeSuccessResponse({ answer: 42 }));

    const promise = aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ answer: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws on persistent 429", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(0.01));

    const promise = aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100);
    const assertion = expect(promise).rejects.toThrow("429");
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });

  it("exhausts retries and includes the error body message on persistent 429", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      make429Response(0.01, "you hit the rate limit"),
    );

    const promise = aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100);
    const assertion = expect(promise).rejects.toThrow("you hit the rate limit");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("propagates the original error when fetch rejects rather than a cryptic TypeError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));

    await expect(aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100)).rejects.toThrow("network failure");
  });

  it("uses the body message delay when retry-after header is absent", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeResponse(429, { error: { message: "try again in 30s" } }))
      .mockResolvedValueOnce(makeSuccessResponse({ answer: 1 }));

    const promise = aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ answer: 1 });
  });

  it("defaults to 10 s delay when neither retry-after header nor body message is present", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeResponse(429, {}))
      .mockResolvedValueOnce(makeSuccessResponse({ answer: 2 }));

    const promise = aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ answer: 2 });
  });

  it("throws with a budget-exceeded message when the total timeout is consumed between retries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse(429, { error: { message: `try again in ${TOTAL_TIMEOUT_MS / 1000 + 5}s` } }),
    );

    const promise = aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100);
    const assertion = expect(promise).rejects.toThrow("exceeded total budget");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("truncates long system and user messages to 200 chars in the log", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeSuccessResponse({}));

    const longSystem = "s".repeat(300);
    const longUser = "u".repeat(300);
    await aiJSON(MOCK_CONFIG, "test", longSystem, longUser, 100);

    const logCall = consoleSpy.mock.calls[0][0] as string;
    expect(logCall).toContain("s".repeat(200) + "…");
    expect(logCall).toContain("u".repeat(200) + "…");
    expect(logCall).not.toContain("s".repeat(201));
    expect(logCall).not.toContain("u".repeat(201));
  });
});
