// Server-side only — AI provider configuration and JSON completion helper.

import type { AiConfig, ProviderCooldownStore } from "../lib/recipes/base";
import type { AiAuditEntry } from "./aiAuditLog";
import { recordAiAuditEntry } from "./aiAuditLog";

export type { AiConfig, ProviderCooldownStore };

const AI_PROVIDERS: Record<string, { url: string; model: string; keyVar: string }> = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    keyVar: "GROQ_API_KEY",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct",
    keyVar: "OPENROUTER_API_KEY",
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.1-flash-lite",
    keyVar: "GEMINI_API_KEY",
  },
};

// Ceiling on how long a single cooldown can sideline a provider — longer than
// any real per-minute/hour rate limit, but short enough that a malformed or
// extreme retry-after value can't blacklist a provider indefinitely with no
// operator recourse short of a restart.
export const MAX_PROVIDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Constructs an isolated store for tracking per-provider rate-limit cooldowns.
// There is no module-scope singleton here — the composition root (vite.config.ts)
// constructs one instance for the life of the server process and threads it into
// every route handler; tests construct their own instance per test instead of
// resetting shared global state.
export function createProviderCooldownStore(): ProviderCooldownStore {
  const cooldownUntilMsByProviderKey = new Map<string, number>();

  function markExhausted(providerKey: string, cooldownUntilMs: number): void {
    const cappedCooldownUntilMs = Math.min(cooldownUntilMs, Date.now() + MAX_PROVIDER_COOLDOWN_MS);
    const currentCooldownUntilMs = cooldownUntilMsByProviderKey.get(providerKey) ?? 0;
    cooldownUntilMsByProviderKey.set(
      providerKey,
      Math.max(currentCooldownUntilMs, cappedCooldownUntilMs),
    );
  }

  function getCooldownUntil(providerKey: string): number | undefined {
    return cooldownUntilMsByProviderKey.get(providerKey);
  }

  return { markExhausted, getCooldownUntil };
}

// Binds a cooldown store to a callable `() => AiConfig` resolver — the shape
// `DiscoverContext.getAiConfig` expects. Named and exported so it stays a
// callable unit in its own right rather than an inline closure at each call site.
export function bindAIConfigResolver(cooldownStore: ProviderCooldownStore): () => AiConfig {
  function resolveAIConfig(): AiConfig {
    return getAIConfig(cooldownStore);
  }
  return resolveAIConfig;
}

type ProviderCandidate =
  | { key: string; status: "available"; config: AiConfig }
  | { key: string; status: "no-key" }
  | { key: string; status: "cooldown"; recoversInSecs: number };

function resolveProviderPriorityOrder(): string[] {
  const allKeys = Object.keys(AI_PROVIDERS);
  const preferredRaw = process.env.AI_PROVIDER;
  if (preferredRaw === undefined) return allKeys;
  const preferred = preferredRaw.toLowerCase();
  if (!AI_PROVIDERS[preferred])
    throw new Error(`Unknown AI_PROVIDER "${preferredRaw}" — use groq, openrouter, or gemini`);
  return [preferred, ...allKeys.filter((key) => key !== preferred)];
}

function evaluateProviderCandidates(cooldownStore: ProviderCooldownStore): ProviderCandidate[] {
  const now = Date.now();
  return resolveProviderPriorityOrder().map((key): ProviderCandidate => {
    const providerConfig = AI_PROVIDERS[key];
    const apiKey = process.env[providerConfig.keyVar];
    if (!apiKey) return { key, status: "no-key" };
    const cooldownUntil = cooldownStore.getCooldownUntil(key);
    if (cooldownUntil !== undefined && cooldownUntil > now) {
      return { key, status: "cooldown", recoversInSecs: Math.ceil((cooldownUntil - now) / 1000) };
    }
    return {
      key,
      status: "available",
      config: {
        url: providerConfig.url,
        model: providerConfig.model,
        apiKey,
        providerKey: key,
        cooldownStore,
      },
    };
  });
}

function formatUnavailableProvidersError(candidates: ProviderCandidate[]): string {
  const details = candidates
    .filter(
      (c): c is Exclude<ProviderCandidate, { status: "available" }> => c.status !== "available",
    )
    .map((c) =>
      c.status === "no-key"
        ? `${c.key}: no ${AI_PROVIDERS[c.key].keyVar} configured`
        : `${c.key}: recovers in ${c.recoversInSecs}s`,
    );
  return `All AI providers unavailable — ${details.join("; ")}`;
}

export function getAIConfig(cooldownStore: ProviderCooldownStore): AiConfig {
  const candidates = evaluateProviderCandidates(cooldownStore);
  const available = candidates.find(
    (c): c is Extract<ProviderCandidate, { status: "available" }> => c.status === "available",
  );
  if (!available) throw new Error(formatUnavailableProvidersError(candidates));
  if (available.key !== candidates[0].key) {
    console.warn(`[AI] ${candidates[0].key} unavailable, using ${available.key} instead`);
  }
  return available.config;
}

type OpenAIResponseShape = { choices?: Array<{ message?: { content?: string } }> };

// A retry delay parsed from a provider-reported source (header or message match) is
// confident — it reflects what the provider actually said. The untagged fallback guess
// is not: it's a hardcoded default for when the provider gave us nothing to parse, and
// must never be trusted the same way a provider-reported value is (see below).
type ParsedRetryDelay = { delaySecs: number; isConfident: boolean };

function parseRetryDelaySeconds(response: Response, errorMessage: string): ParsedRetryDelay {
  const header = response.headers.get("retry-after");
  if (header) {
    const parsed = Number.parseFloat(header);
    if (!Number.isNaN(parsed)) return { delaySecs: parsed, isConfident: true };
  }
  const match = errorMessage.match(/try again in (\d+\.?\d*)s/i);
  if (match) return { delaySecs: Number.parseFloat(match[1]), isConfident: true };
  // Verified accurate for Groq (its reported delay matches its real daily-quota
  // reset) and for OpenRouter (its docs confirm a standard retry-after header on
  // 429s, which the branch above already handles). NOT verified for Gemini —
  // Google's docs don't publish the OpenAI-compatible endpoint's 429 error shape,
  // so confirm it against a live captured response before trusting this default
  // to distinguish a short rate limit from a full quota exhaustion for Gemini.
  // Because it's unverified for Gemini, callers must not treat it as confident:
  // it must not justify a fail-fast decision or a recorded provider cooldown,
  // only a single in-process retry sleep.
  return { delaySecs: 10, isConfident: false };
}

function extractErrorBodyMessage(errorData: Record<string, unknown>): string | undefined {
  const errorBody = (Array.isArray(errorData) ? errorData[0] : errorData) as Record<
    string,
    unknown
  >;
  const message = (errorBody?.error as Record<string, unknown>)?.message ?? errorBody?.message;
  return typeof message === "string" ? message : undefined;
}

function extractJsonContent(raw: string): string {
  // Extract JSON from a markdown code fence if the model wrapped it in prose
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  // Fallback: grab from first { to last }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  return jsonMatch ? jsonMatch[0].trim() : raw.trim();
}

export const MAX_RETRIES = 2;
export const TOTAL_TIMEOUT_MS = 45_000;

type AuditEntryOverrides = Omit<
  AiAuditEntry,
  "timestamp" | "label" | "model" | "systemMessage" | "userMessage"
>;

function buildAuditEntry(
  context: { label: string; model: string; systemMessage: string; userMessage: string },
  overrides: AuditEntryOverrides,
): AiAuditEntry {
  return { timestamp: new Date().toISOString(), ...context, ...overrides };
}

// The result of one aiJSON call. `aiJSON` is a pure HTTP/retry executor — it never
// touches the cooldown store itself. When a 429 response confidently reports a
// rate limit (see `ParsedRetryDelay.isConfident`), it hands back everything an
// orchestration layer needs to update cooldown policy (`providerKey`,
// `cooldownUntilMs`) instead of mutating that state as a side effect. Every other
// failure (non-429 errors, network errors, parse errors, an unconfident guess, or
// exceeding the total time budget) is still a thrown `Error` — those aren't a
// cooldown-policy decision, just outright failures.
export type AiJsonResult =
  | { kind: "ok"; value: unknown }
  | { kind: "rate-limited"; providerKey: string; cooldownUntilMs: number; message: string };

// Thin orchestration layer above `aiJSON`: applies a rate-limited outcome to the
// cooldown store and re-throws it as a plain `Error`, or unwraps a successful
// value. Callers that only care about "did this succeed" can keep treating AI
// calls as throw-on-failure while still being the ones responsible for deciding
// what a rate-limited outcome means for provider cooldown — `aiJSON` itself no
// longer makes that decision.
export function applyAiJsonResult(
  cooldownStore: ProviderCooldownStore,
  result: AiJsonResult,
): unknown {
  if (result.kind === "ok") return result.value;
  cooldownStore.markExhausted(result.providerKey, result.cooldownUntilMs);
  throw new Error(result.message);
}

function buildRateLimitedMessage(
  label: string,
  delaySecs: number,
  exceedsBudget: boolean,
  errorMessage: string,
): string {
  return exceedsBudget
    ? `AI rate limited (${label}): provider asks to retry in ${delaySecs}s, exceeds ${TOTAL_TIMEOUT_MS / 1000}s budget`
    : `AI rate limited (${label}): retries exhausted, provider still reports rate limiting — ${errorMessage}`;
}

// Pure classification of what a 429 response means for the retry loop, isolated from the
// transport/audit side effects around it — this is the part of `aiJSON` that keeps colliding
// with itself across independent rewrites (see the merge-conflict review for fix/groq-rate-limiting).
// `nowMs` is passed in rather than read via `Date.now()` so this stays fully deterministic and
// testable without mocking `fetch` or timers.
export type RateLimitDecision =
  | { action: "return"; result: AiJsonResult }
  | { action: "retry"; sleepMs: number }
  | { action: "fall-through" };

export function decideRateLimitOutcome(
  providerKey: string,
  label: string,
  errorMessage: string,
  delaySecs: number,
  isConfident: boolean,
  remainingMs: number,
  outOfRetries: boolean,
  nowMs: number,
): RateLimitDecision {
  const rateLimitedResult = (exceedsBudget: boolean): AiJsonResult => ({
    kind: "rate-limited",
    providerKey,
    cooldownUntilMs: nowMs + delaySecs * 1000,
    message: buildRateLimitedMessage(label, delaySecs, exceedsBudget, errorMessage),
  });

  if (isConfident && delaySecs * 1000 > remainingMs) {
    return { action: "return", result: rateLimitedResult(true) };
  }
  if (!outOfRetries) {
    const sleepMs = Math.min(delaySecs * 1000, Math.max(remainingMs - 1, 0));
    return { action: "retry", sleepMs };
  }
  // Out of retries. A confident signal is still worth reporting up for cooldown/rotation
  // even on the final attempt; an unconfident guess must not be trusted to make that call,
  // so it falls through to the generic http_error path instead.
  if (isConfident) {
    return { action: "return", result: rateLimitedResult(false) };
  }
  return { action: "fall-through" };
}

export async function aiJSON(
  aiConfig: AiConfig,
  label: string,
  systemMessage: string,
  userMessage: string,
  maxTokens: number,
): Promise<AiJsonResult> {
  console.log(`[AI] ${label} → calling model: ${aiConfig.model}`);

  const auditContext = { label, model: aiConfig.model, systemMessage, userMessage };
  const recordAttempt = (overrides: AuditEntryOverrides) =>
    recordAiAuditEntry(buildAuditEntry(auditContext, overrides));
  function recordRateLimitedAttempt(
    attempt: number,
    errorMessage: string,
    attemptStartedAt: number,
  ): void {
    recordAttempt({
      attempt,
      status: "rate_limited",
      httpStatus: 429,
      errorMessage,
      durationMs: Date.now() - attemptStartedAt,
    });
  }

  const requestBody = JSON.stringify({
    model: aiConfig.model,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ],
  });
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastErrorData: Record<string, unknown> = {};

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      const attemptStartedAt = Date.now();
      const remaining = deadline - attemptStartedAt;
      if (remaining <= 0) {
        const errorMessage = `AI request failed: exceeded total budget (${label})`;
        recordAttempt({ attempt, status: "budget_exceeded", errorMessage, durationMs: 0 });
        throw new Error(errorMessage);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(30_000, remaining));
      let apiResponse: Response;
      try {
        apiResponse = await fetch(aiConfig.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${aiConfig.apiKey}`,
            "Content-Type": "application/json",
          },
          body: requestBody,
          signal: controller.signal,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        recordAttempt({
          attempt,
          status: "network_error",
          errorMessage,
          durationMs: Date.now() - attemptStartedAt,
        });
        throw error;
      } finally {
        clearTimeout(timer);
      }

      if (!apiResponse.ok) {
        const parsed = (await apiResponse.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        if (parsed !== null) lastErrorData = parsed;
        const bodyMessage = extractErrorBodyMessage(lastErrorData);
        const errorMessage = bodyMessage || apiResponse.statusText || JSON.stringify(lastErrorData);

        if (apiResponse.status === 429) {
          const { delaySecs, isConfident } = parseRetryDelaySeconds(apiResponse, bodyMessage ?? "");
          const remainingMs = deadline - Date.now();
          const outOfRetries = attempt > MAX_RETRIES;
          const decision = decideRateLimitOutcome(
            aiConfig.providerKey,
            label,
            errorMessage,
            delaySecs,
            isConfident,
            remainingMs,
            outOfRetries,
            Date.now(),
          );

          if (decision.action !== "fall-through") {
            recordRateLimitedAttempt(attempt, errorMessage, attemptStartedAt);
          }
          if (decision.action === "return") return decision.result;
          if (decision.action === "retry") {
            console.warn(`[AI] ${label} → rate limited, retrying in ${decision.sleepMs / 1000}s`);
            await new Promise<void>((resolve) => setTimeout(resolve, decision.sleepMs));
            continue;
          }
          // fall-through: an unconfident guess out of retries drops to the generic http_error path below.
        }

        recordAttempt({
          attempt,
          status: "http_error",
          httpStatus: apiResponse.status,
          errorMessage,
          durationMs: Date.now() - attemptStartedAt,
        });
        throw new Error(`AI error (${label}) [${apiResponse.status}]: ${errorMessage}`);
      }

      let responseData: OpenAIResponseShape;
      try {
        responseData = (await apiResponse.json()) as OpenAIResponseShape;
      } catch {
        const errorMessage = `AI error (${label}): malformed 200 response body`;
        recordAttempt({
          attempt,
          status: "http_error",
          httpStatus: apiResponse.status,
          errorMessage,
          durationMs: Date.now() - attemptStartedAt,
        });
        throw new Error(errorMessage);
      }
      const raw: string = responseData.choices?.[0]?.message?.content ?? "{}";
      const stripped = extractJsonContent(raw);
      try {
        const result: unknown = JSON.parse(stripped);
        recordAttempt({
          attempt,
          status: "success",
          response: result,
          durationMs: Date.now() - attemptStartedAt,
        });
        console.log(`[AI] ${label} → success`);
        return { kind: "ok", value: result };
      } catch {
        const errorMessage = `AI parse error (${label}): ${stripped.slice(0, 200)}`;
        recordAttempt({
          attempt,
          status: "parse_error",
          rawContent: raw,
          errorMessage,
          durationMs: Date.now() - attemptStartedAt,
        });
        throw new Error(errorMessage);
      }
    }
    throw new Error(`AI request failed: no response received (${label})`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[AI] ${label} → failed: ${errorMessage}`);
    throw error;
  }
}
