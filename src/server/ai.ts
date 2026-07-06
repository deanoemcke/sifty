// Server-side only — AI provider configuration and JSON completion helper.

import type { AiConfig, ProviderCooldownStore } from "../lib/recipes/base";

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

function extractRetryMessage(lastErrorData: Record<string, unknown>): string {
  const errorBody = (Array.isArray(lastErrorData) ? lastErrorData[0] : lastErrorData) as Record<
    string,
    unknown
  >;
  return String((errorBody?.error as Record<string, unknown>)?.message ?? errorBody?.message ?? "");
}

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

export const MAX_RETRIES = 2;
export const TOTAL_TIMEOUT_MS = 45_000;

function truncate(text: string, limit = 200): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
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

export async function aiJSON(
  aiConfig: AiConfig,
  label: string,
  systemMessage: string,
  userMessage: string,
  maxTokens: number,
): Promise<AiJsonResult> {
  console.log(
    `[AI] ${label} → model: ${aiConfig.model}\n[system] ${truncate(systemMessage)}\n[user] ${truncate(userMessage)}`,
  );
  const requestBody = JSON.stringify({
    model: aiConfig.model,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ],
  });
  let apiResponse: Response | undefined;
  let lastErrorData: Record<string, unknown> = {};
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`AI request failed: exceeded total budget (${label})`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(30_000, remaining));
    try {
      apiResponse = await fetch(aiConfig.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${aiConfig.apiKey}`, "Content-Type": "application/json" },
        body: requestBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!apiResponse.ok) {
      const parsed = (await apiResponse.json().catch(() => null)) as Record<string, unknown> | null;
      if (parsed !== null) lastErrorData = parsed;
      if (apiResponse.status === 429 && attempt < MAX_RETRIES) {
        const errorMessage = extractRetryMessage(lastErrorData);
        const { delaySecs, isConfident } = parseRetryDelaySeconds(apiResponse, errorMessage);
        const remainingMs = deadline - Date.now();
        if (isConfident && delaySecs * 1000 > remainingMs) {
          return {
            kind: "rate-limited",
            providerKey: aiConfig.providerKey,
            cooldownUntilMs: Date.now() + delaySecs * 1000,
            message: `AI rate limited (${label}): provider asks to retry in ${delaySecs}s, exceeds ${TOTAL_TIMEOUT_MS / 1000}s budget`,
          };
        }
        console.warn(`[AI] ${label} → rate limited, retrying in ${delaySecs}s`);
        await new Promise<void>((resolve) => setTimeout(resolve, delaySecs * 1000));
        continue;
      }
      break;
    }
    break;
  }
  if (apiResponse === undefined)
    throw new Error(`AI request failed: no response received (${label})`);
  if (!apiResponse.ok) {
    const errorBody = (Array.isArray(lastErrorData) ? lastErrorData[0] : lastErrorData) as Record<
      string,
      unknown
    >;
    const errorMessage =
      (errorBody?.error as Record<string, unknown>)?.message ??
      errorBody?.message ??
      JSON.stringify(lastErrorData);
    const message = `AI error (${label}) [${apiResponse.status}]: ${errorMessage || apiResponse.statusText}`;
    if (apiResponse.status === 429) {
      const { delaySecs, isConfident } = parseRetryDelaySeconds(
        apiResponse,
        extractRetryMessage(lastErrorData),
      );
      if (isConfident) {
        return {
          kind: "rate-limited",
          providerKey: aiConfig.providerKey,
          cooldownUntilMs: Date.now() + delaySecs * 1000,
          message,
        };
      }
    }
    throw new Error(message);
  }
  const responseData = (await apiResponse.json()) as OpenAIResponseShape;
  const raw: string = responseData.choices?.[0]?.message?.content ?? "{}";
  // Extract JSON from a markdown code fence if the model wrapped it in prose
  let stripped: string;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    stripped = fenceMatch[1].trim();
  } else {
    // Fallback: grab from first { to last }
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    stripped = jsonMatch ? jsonMatch[0].trim() : raw.trim();
  }
  try {
    return { kind: "ok", value: JSON.parse(stripped) };
  } catch {
    throw new Error(`AI parse error (${label}): ${stripped.slice(0, 200)}`);
  }
}
