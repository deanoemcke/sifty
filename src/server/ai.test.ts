import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "./ai";
import { aiJSON, getAIConfig, MAX_RETRIES, resetProviderCooldowns, TOTAL_TIMEOUT_MS } from "./ai";

const MOCK_CONFIG: AiConfig = {
  url: "https://api.example.com/chat",
  model: "test-model",
  apiKey: "test-key",
};

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
  beforeEach(() => {
    vi.useFakeTimers();
    resetProviderCooldowns();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
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

  it("throws immediately without sleeping when the provider's retry delay exceeds the total budget", async () => {
    const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(make429Response(overBudgetSecs));

    await expect(aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100)).rejects.toThrow(
      `AI rate limited (test): provider asks to retry in ${overBudgetSecs}s, exceeds ${TOTAL_TIMEOUT_MS / 1000}s budget`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  describe("getAIConfig", () => {
    beforeEach(() => {
      vi.stubEnv("AI_PROVIDER", undefined);
      vi.stubEnv("GROQ_API_KEY", undefined);
      vi.stubEnv("OPENROUTER_API_KEY", undefined);
      vi.stubEnv("GEMINI_API_KEY", undefined);
    });

    it("returns the sole configured provider when only its API key is set and AI_PROVIDER is unset", () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");

      const config = getAIConfig();

      expect(config.url).toBe(GROQ_URL);
      expect(config.apiKey).toBe("groq-key");
    });

    it("throws Unknown AI_PROVIDER when AI_PROVIDER is set to an unrecognized value", () => {
      vi.stubEnv("AI_PROVIDER", "bogus");
      vi.stubEnv("GROQ_API_KEY", "groq-key");

      expect(() => getAIConfig()).toThrow('Unknown AI_PROVIDER "bogus"');
    });

    it("prefers the provider named by AI_PROVIDER over the default-first provider when both have keys configured", () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
      vi.stubEnv("AI_PROVIDER", "openrouter");

      const config = getAIConfig();

      expect(config.url).toBe(OPENROUTER_URL);
    });

    it("throws an aggregate error naming every provider when no API keys are set at all", () => {
      expect(() => getAIConfig()).toThrow(
        /groq: no GROQ_API_KEY configured.*openrouter: no OPENROUTER_API_KEY configured.*gemini: no GEMINI_API_KEY configured/s,
      );
    });

    it("falls back to the next configured provider after the fast-fail branch marks the first one exhausted", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
      const groqConfig = getAIConfig();
      expect(groqConfig.url).toBe(GROQ_URL);

      const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(overBudgetSecs));
      await expect(aiJSON(groqConfig, "test", "sys", "usr", 100)).rejects.toThrow("AI rate limited");

      const nextConfig = getAIConfig();
      expect(nextConfig.url).toBe(OPENROUTER_URL);
    });

    it("falls back to the next configured provider after retries are exhausted on persistent 429s", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
      const groqConfig = getAIConfig();

      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(0.01));
      const promise = aiJSON(groqConfig, "test", "sys", "usr", 100);
      const assertion = expect(promise).rejects.toThrow("429");
      await vi.runAllTimersAsync();
      await assertion;

      const nextConfig = getAIConfig();
      expect(nextConfig.url).toBe(OPENROUTER_URL);
    });

    it("reports both a cooldown recovery time and missing-key providers in the aggregate error", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig();

      const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(overBudgetSecs));
      await expect(aiJSON(groqConfig, "test", "sys", "usr", 100)).rejects.toThrow("AI rate limited");

      expect(() => getAIConfig()).toThrow(
        /groq: recovers in \d+s.*openrouter: no OPENROUTER_API_KEY configured.*gemini: no GEMINI_API_KEY configured/s,
      );
    });

    it("picks the cooled-down provider again once its cooldown has elapsed", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig();

      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(1));
      const promise = aiJSON(groqConfig, "test", "sys", "usr", 100);
      const assertion = expect(promise).rejects.toThrow("429");
      await vi.runAllTimersAsync();
      await assertion;

      expect(() => getAIConfig()).toThrow("groq: recovers in");

      await vi.advanceTimersByTimeAsync(1_100);
      const recoveredConfig = getAIConfig();
      expect(recoveredConfig.url).toBe(GROQ_URL);
    });

    it("does not mark cooldown when the failing config's URL matches no known provider", async () => {
      const overBudgetSecs = TOTAL_TIMEOUT_MS / 1000 + 5;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(make429Response(overBudgetSecs));
      await expect(aiJSON(MOCK_CONFIG, "test", "sys", "usr", 100)).rejects.toThrow("AI rate limited");

      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const config = getAIConfig();
      expect(config.url).toBe(GROQ_URL);
    });

    it("does not mark cooldown on non-429 errors", async () => {
      vi.stubEnv("GROQ_API_KEY", "groq-key");
      const groqConfig = getAIConfig();

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        makeResponse(500, { error: { message: "server error" } }),
      );
      await expect(aiJSON(groqConfig, "test", "sys", "usr", 100)).rejects.toThrow("500");

      const config = getAIConfig();
      expect(config.url).toBe(GROQ_URL);
    });
  });
});
