import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "./ai";
import { aiJSON, MAX_RETRIES, TOTAL_TIMEOUT_MS } from "./ai";
import { recordAiAuditEntry } from "./aiAuditLog";

vi.mock("./aiAuditLog", () => ({ recordAiAuditEntry: vi.fn() }));

const recordAiAuditEntryMock = vi.mocked(recordAiAuditEntry);

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
    recordAiAuditEntryMock.mockClear();
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

  it("records one audit entry per HTTP attempt — rate_limited then success", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(make429Response(0.01))
      .mockResolvedValueOnce(makeSuccessResponse({ answer: 42 }));

    const promise = aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    await promise;

    expect(recordAiAuditEntryMock).toHaveBeenCalledTimes(2);
    expect(recordAiAuditEntryMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        label: "test",
        attempt: 1,
        status: "rate_limited",
        httpStatus: 429,
        systemMessage: "sys",
        userMessage: "usr",
      }),
    );
    expect(recordAiAuditEntryMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ attempt: 2, status: "success", response: { answer: 42 } }),
    );
  });

  it("exhausts retries and throws on persistent 429", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(0.01));

    const promise = aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100);
    const assertion = expect(promise).rejects.toThrow("429");
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(recordAiAuditEntryMock).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(
      recordAiAuditEntryMock.mock.calls.slice(0, MAX_RETRIES).map((call) => call[0].status),
    ).toEqual(Array(MAX_RETRIES).fill("rate_limited"));
    expect(recordAiAuditEntryMock.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "http_error",
      httpStatus: 429,
    });
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

    expect(recordAiAuditEntryMock).toHaveBeenCalledTimes(1);
    expect(recordAiAuditEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        status: "network_error",
        errorMessage: "network failure",
      }),
    );
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

    expect(recordAiAuditEntryMock.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "budget_exceeded",
    });
  });

  it("records a parse_error audit entry with the raw content when the model response isn't valid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(200, { choices: [{ message: { content: "not json at all" } }] }),
    );

    await expect(aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100)).rejects.toThrow("AI parse error");

    expect(recordAiAuditEntryMock).toHaveBeenCalledTimes(1);
    expect(recordAiAuditEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        status: "parse_error",
        rawContent: "not json at all",
      }),
    );
  });

  it("logs only a short model-name line to the console, not the full prompts", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeSuccessResponse({ answer: 1 }));

    const longSystem = "s".repeat(300);
    const longUser = "u".repeat(300);
    await aiJSON(MOCK_CONFIG, "test", longSystem, longUser, 100);

    const logMessages = consoleLogSpy.mock.calls.map((call) => call[0]);
    for (const message of logMessages) {
      expect(message).not.toContain(longSystem);
      expect(message).not.toContain(longUser);
    }
    expect(logMessages).toContain(`[AI] test → calling model: ${MOCK_CONFIG.model}`);
    expect(logMessages).toContain("[AI] test → success");

    expect(recordAiAuditEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ systemMessage: longSystem, userMessage: longUser }),
    );
  });

  it("logs a failure reason to the console on error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));

    await expect(aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100)).rejects.toThrow("network failure");

    expect(consoleErrorSpy).toHaveBeenCalledWith("[AI] test → failed: network failure");
  });
});
