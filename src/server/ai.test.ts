import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig, ProviderCooldownStore } from "./ai";
import {
  aiJSON,
  applyAiJsonResult,
  createProviderCooldownStore,
  getAIConfig,
  MAX_PROVIDER_COOLDOWN_MS,
  MAX_RETRIES,
  TOTAL_TIMEOUT_MS,
} from "./ai";
import { recordAiAuditEntry } from "./aiAuditLog";

vi.mock("./aiAuditLog", () => ({ recordAiAuditEntry: vi.fn() }));

const recordAiAuditEntryMock = vi.mocked(recordAiAuditEntry);

function makeMockConfig(cooldownStore: ProviderCooldownStore): AiConfig {
  return {
    url: "https://api.example.com/chat",
    model: "test-model",
    apiKey: "test-key",
    providerKey: "mock-provider",
    cooldownStore,
  };
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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
  let cooldownStore: ProviderCooldownStore;

  beforeEach(() => {
    vi.useFakeTimers();
    cooldownStore = createProviderCooldownStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    recordAiAuditEntryMock.mockClear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("retries on 429 and returns the successful result", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(make429Response(0.01))
      .mockResolvedValueOnce(makeSuccessResponse({ answer: 42 }));

    const promise = aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(applyAiJsonResult(cooldownStore, result)).toEqual({ answer: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records one audit entry per HTTP attempt — rate_limited then success", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(make429Response(0.01))
      .mockResolvedValueOnce(makeSuccessResponse({ answer: 42 }));

    const promise = aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
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

  it("exhausts retries and returns a rate-limited result on persistent 429, recording every attempt as rate_limited", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(0.01));

    const promise = aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.kind).toBe("rate-limited");
    expect(() => applyAiJsonResult(cooldownStore, result)).toThrow("429");
    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(recordAiAuditEntryMock).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(recordAiAuditEntryMock.mock.calls.map((call) => call[0].status)).toEqual(
      Array(1 + MAX_RETRIES).fill("rate_limited"),
    );
  });

  it("does not touch the cooldown store itself — a rate-limited result carries the provider key and cooldown time without mutating state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(0.01));

    const promise = aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({
      kind: "rate-limited",
      providerKey: "mock-provider",
    });
    // aiJSON returning the result must not itself have called markExhausted.
    expect(cooldownStore.getCooldownUntil("mock-provider")).toBeUndefined();
  });

  describe("applyAiJsonResult", () => {
    it("returns the value unchanged for an ok result", () => {
      expect(applyAiJsonResult(cooldownStore, { kind: "ok", value: { answer: 1 } })).toEqual({
        answer: 1,
      });
    });

    it("marks the cooldown store exhausted and throws for a rate-limited result", () => {
      const cooldownUntilMs = Date.now() + 60_000;
      expect(() =>
        applyAiJsonResult(cooldownStore, {
          kind: "rate-limited",
          providerKey: "mock-provider",
          cooldownUntilMs,
          message: "AI rate limited (test): provider asks to retry",
        }),
      ).toThrow("AI rate limited (test): provider asks to retry");

      expect(cooldownStore.getCooldownUntil("mock-provider")).toBe(cooldownUntilMs);
    });
  });

  it("exhausts retries and includes the error body message on persistent 429", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      make429Response(0.01, "you hit the rate limit"),
    );

    const promise = aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(() => applyAiJsonResult(cooldownStore, result)).toThrow("you hit the rate limit");
  });

  it("propagates the original error when fetch rejects rather than a cryptic TypeError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));

    await expect(aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100)).rejects.toThrow(
      "network failure",
    );

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

    const promise = aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(applyAiJsonResult(cooldownStore, result)).toEqual({ answer: 1 });
  });

  it("treats OpenRouter's documented 429 shape (retry-after header, generic metadata-only message) as a confident delay", async () => {
    const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse(
        429,
        {
          error: {
            code: 429,
            message: "Rate limit exceeded",
            metadata: {
              headers: { "X-RateLimit-Limit": "80", "X-RateLimit-Remaining": "0" },
            },
          },
        },
        { "retry-after": String(overBudgetSecs) },
      ),
    );

    const result = await aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
    expect(() => applyAiJsonResult(cooldownStore, result)).toThrow(
      `AI rate limited (test): provider asks to retry in ${overBudgetSecs}s, exceeds ${TOTAL_TIMEOUT_MS / 1000}s budget`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults to 10 s delay when neither retry-after header nor body message is present", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeResponse(429, {}))
      .mockResolvedValueOnce(makeSuccessResponse({ answer: 2 }));

    const promise = aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(applyAiJsonResult(cooldownStore, result)).toEqual({ answer: 2 });
  });

  it("throws immediately without sleeping when the provider's retry delay exceeds the total budget", async () => {
    const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(make429Response(overBudgetSecs));

    const result = await aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
    expect(() => applyAiJsonResult(cooldownStore, result)).toThrow(
      `AI rate limited (test): provider asks to retry in ${overBudgetSecs}s, exceeds ${TOTAL_TIMEOUT_MS / 1000}s budget`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordAiAuditEntryMock.mock.calls.at(-1)?.[0]).toMatchObject({ status: "rate_limited" });
  });

  it("returns a rate-limited result without sleeping when a message-matched retry delay exceeds the total budget", async () => {
    const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse(429, { error: { message: `try again in ${overBudgetSecs}s` } }),
    );

    const result = await aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);

    expect(result.kind).toBe("rate-limited");
    expect(() => applyAiJsonResult(cooldownStore, result)).toThrow(
      `AI rate limited (test): provider asks to retry in ${overBudgetSecs}s, exceeds ${TOTAL_TIMEOUT_MS / 1000}s budget`,
    );
    expect(recordAiAuditEntryMock.mock.calls.at(-1)?.[0]).toMatchObject({ status: "rate_limited" });
  });

  it("records a parse_error audit entry with the raw content when the model response isn't valid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(200, { choices: [{ message: { content: "not json at all" } }] }),
    );

    await expect(
      aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100),
    ).rejects.toThrow("AI parse error");

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
    const aiConfig = makeMockConfig(cooldownStore);
    await aiJSON(aiConfig, "test", longSystem, longUser, 100);

    const logMessages = consoleLogSpy.mock.calls.map((call) => call[0]);
    for (const message of logMessages) {
      expect(message).not.toContain(longSystem);
      expect(message).not.toContain(longUser);
    }
    expect(logMessages).toContain(`[AI] test → calling model: ${aiConfig.model}`);
    expect(logMessages).toContain("[AI] test → success");

    expect(recordAiAuditEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ systemMessage: longSystem, userMessage: longUser }),
    );
  });

  it("logs a failure reason to the console on error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));

    await expect(
      aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100),
    ).rejects.toThrow("network failure");

    expect(consoleErrorSpy).toHaveBeenCalledWith("[AI] test → failed: network failure");
  });

  describe("getAIConfig", () => {
    beforeEach(() => {
      vi.stubEnv("AI_PROVIDER", undefined);
      vi.stubEnv("GROQ_API_KEY", undefined);
      vi.stubEnv("OPENROUTER_API_KEY", undefined);
      vi.stubEnv("GEMINI_API_KEY", undefined);
    });

    it("returns the sole configured provider when only its API key is set and AI_PROVIDER is unset", () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");

      const config = getAIConfig(cooldownStore);

      expect(config.url).toBe(GROQ_URL);
      expect(config.apiKey).toBe("groq-key");
    });

    it("throws Unknown AI_PROVIDER when AI_PROVIDER is set to an unrecognized value", () => {
      vi.stubEnv("AI_PROVIDER", "bogus");
      vi.stubEnv("GROQ_API_KEY", "groq-key");

      expect(() => getAIConfig(cooldownStore)).toThrow('Unknown AI_PROVIDER "bogus"');
    });

    it("prefers the provider named by AI_PROVIDER over the default-first provider when both have keys configured", () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
      vi.stubEnv("AI_PROVIDER", "openrouter");

      const config = getAIConfig(cooldownStore);

      expect(config.url).toBe(OPENROUTER_URL);
    });

    it("throws an aggregate error naming every provider when no API keys are set at all", () => {
      expect(() => getAIConfig(cooldownStore)).toThrow(
        /groq: no GROQ_API_KEY configured.*openrouter: no OPENROUTER_API_KEY configured.*gemini: no GEMINI_API_KEY configured/s,
      );
    });

    it("falls back to the next configured provider after the fast-fail branch marks the first one exhausted", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
      const groqConfig = getAIConfig(cooldownStore);
      expect(groqConfig.url).toBe(GROQ_URL);

      const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(overBudgetSecs));
      const result = await aiJSON(groqConfig, "test", "sys", "usr", 100);
      expect(() => applyAiJsonResult(cooldownStore, result)).toThrow("AI rate limited");

      const nextConfig = getAIConfig(cooldownStore);
      expect(nextConfig.url).toBe(OPENROUTER_URL);
    });

    it("falls back to the next configured provider after retries are exhausted on persistent 429s", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
      const groqConfig = getAIConfig(cooldownStore);

      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(0.01));
      const promise = aiJSON(groqConfig, "test", "sys", "usr", 100);
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(() => applyAiJsonResult(cooldownStore, result)).toThrow("429");

      const nextConfig = getAIConfig(cooldownStore);
      expect(nextConfig.url).toBe(OPENROUTER_URL);
    });

    it("reports both a cooldown recovery time and missing-key providers in the aggregate error", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig(cooldownStore);

      const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(overBudgetSecs));
      const result = await aiJSON(groqConfig, "test", "sys", "usr", 100);
      expect(() => applyAiJsonResult(cooldownStore, result)).toThrow("AI rate limited");

      expect(() => getAIConfig(cooldownStore)).toThrow(
        /groq: recovers in \d+s.*openrouter: no OPENROUTER_API_KEY configured.*gemini: no GEMINI_API_KEY configured/s,
      );
    });

    it("picks the cooled-down provider again once its cooldown has elapsed", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig(cooldownStore);

      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(1));
      const promise = aiJSON(groqConfig, "test", "sys", "usr", 100);
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(() => applyAiJsonResult(cooldownStore, result)).toThrow("429");

      expect(() => getAIConfig(cooldownStore)).toThrow("groq: recovers in");

      await vi.advanceTimersByTimeAsync(1_100);
      const recoveredConfig = getAIConfig(cooldownStore);
      expect(recoveredConfig.url).toBe(GROQ_URL);
    });

    it("marks cooldown against the config's own providerKey, so an unrelated config's exhaustion doesn't affect a real provider", async () => {
      const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(overBudgetSecs));
      const result = await aiJSON(makeMockConfig(cooldownStore), "test", "sys", "usr", 100);
      expect(() => applyAiJsonResult(cooldownStore, result)).toThrow("AI rate limited");

      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const config = getAIConfig(cooldownStore);
      expect(config.url).toBe(GROQ_URL);
    });

    it("keeps the longer cooldown when a later call reports a shorter delay for the same provider", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig(cooldownStore);

      const longDelaySecs = TOTAL_TIMEOUT_MS / 1000 + 100;
      const shortDelaySecs = TOTAL_TIMEOUT_MS / 1000 + 5;
      const fetchMock = vi.spyOn(globalThis, "fetch");

      fetchMock.mockResolvedValueOnce(make429Response(longDelaySecs));
      const firstResult = await aiJSON(groqConfig, "test", "sys", "usr", 100);
      expect(() => applyAiJsonResult(cooldownStore, firstResult)).toThrow("AI rate limited");

      fetchMock.mockResolvedValueOnce(make429Response(shortDelaySecs));
      const secondResult = await aiJSON(groqConfig, "test", "sys", "usr", 100);
      expect(() => applyAiJsonResult(cooldownStore, secondResult)).toThrow("AI rate limited");

      expect(() => getAIConfig(cooldownStore)).toThrow(`recovers in ${Math.ceil(longDelaySecs)}s`);
    });

    it("caps an extreme retry-after delay to the cooldown ceiling instead of blacklisting the provider indefinitely", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig(cooldownStore);

      const extremeDelaySecs = 999_999_999;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(extremeDelaySecs));
      const result = await aiJSON(groqConfig, "test", "sys", "usr", 100);
      expect(() => applyAiJsonResult(cooldownStore, result)).toThrow("AI rate limited");

      const cappedRecoversInSecs = Math.ceil(MAX_PROVIDER_COOLDOWN_MS / 1000);
      expect(() => getAIConfig(cooldownStore)).toThrow(`recovers in ${cappedRecoversInSecs}s`);
    });

    it("does not fail fast on an unconfident guessed delay even when it would exceed the remaining budget", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig(cooldownStore);

      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        // Attempt 1: confident (header-reported) delay of 40s, within the 45s budget — sleeps as normal.
        .mockResolvedValueOnce(make429Response(40))
        // Attempt 2: no retry-after header and no matching body message, so the parsed delay is the
        // untagged 10s fallback guess. Only ~5s of budget remains at this point, so a confident delay
        // would fail fast here — but a guess must not be trusted to make that call.
        .mockResolvedValueOnce(makeResponse(429, {}));

      const promise = aiJSON(groqConfig, "test", "sys", "usr", 100);
      const assertion = expect(promise).rejects.toThrow("exceeded total budget");
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The guess must not have sidelined the provider with a cooldown.
      const recheckedConfig = getAIConfig(cooldownStore);
      expect(recheckedConfig.url).toBe(GROQ_URL);
    });

    it("does not mark cooldown from an unconfident guessed delay once retries are exhausted on persistent 429s", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig(cooldownStore);

      vi.spyOn(globalThis, "fetch").mockResolvedValue(makeResponse(429, {}));

      const promise = aiJSON(groqConfig, "test", "sys", "usr", 100);
      const assertion = expect(promise).rejects.toThrow("429");
      await vi.runAllTimersAsync();
      await assertion;

      const config = getAIConfig(cooldownStore);
      expect(config.url).toBe(GROQ_URL);
    });

    it("does not mark cooldown on non-429 errors", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig(cooldownStore);

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        makeResponse(500, { error: { message: "server error" } }),
      );
      await expect(aiJSON(groqConfig, "test", "sys", "usr", 100)).rejects.toThrow("500");

      const config = getAIConfig(cooldownStore);
      expect(config.url).toBe(GROQ_URL);
    });

    it("keeps cooldown state isolated between independently constructed stores", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const storeA = createProviderCooldownStore();
      const storeB = createProviderCooldownStore();
      const configFromStoreA = getAIConfig(storeA);

      const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(overBudgetSecs));
      const result = await aiJSON(configFromStoreA, "test", "sys", "usr", 100);
      expect(() => applyAiJsonResult(storeA, result)).toThrow("AI rate limited");

      // storeA now has groq in cooldown...
      expect(() => getAIConfig(storeA)).toThrow("groq: recovers in");
      // ...but storeB, constructed independently, was never told about that exhaustion.
      expect(getAIConfig(storeB).url).toBe(GROQ_URL);
    });
  });
});
