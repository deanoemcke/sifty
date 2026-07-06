// Server-side only — AI provider configuration and JSON completion helper.

import type { AiConfig } from "../lib/recipes/base";

export type { AiConfig };

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

// provider key -> epoch ms when its cooldown ends
const providerCooldowns = new Map<string, number>();

// Ceiling on how long a single cooldown can sideline a provider — longer than
// any real per-minute/hour rate limit, but short enough that a malformed or
// extreme retry-after value can't blacklist a provider indefinitely with no
// operator recourse short of a restart.
export const MAX_PROVIDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function markProviderExhausted(providerKey: string, cooldownUntilMs: number): void {
  const cappedCooldownUntilMs = Math.min(cooldownUntilMs, Date.now() + MAX_PROVIDER_COOLDOWN_MS);
  const currentCooldownUntilMs = providerCooldowns.get(providerKey) ?? 0;
  providerCooldowns.set(providerKey, Math.max(currentCooldownUntilMs, cappedCooldownUntilMs));
}

export function resetProviderCooldowns(): void {
  providerCooldowns.clear();
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

function evaluateProviderCandidates(): ProviderCandidate[] {
  const now = Date.now();
  return resolveProviderPriorityOrder().map((key): ProviderCandidate => {
    const providerConfig = AI_PROVIDERS[key];
    const apiKey = process.env[providerConfig.keyVar];
    if (!apiKey) return { key, status: "no-key" };
    const cooldownUntil = providerCooldowns.get(key);
    if (cooldownUntil !== undefined && cooldownUntil > now) {
      return { key, status: "cooldown", recoversInSecs: Math.ceil((cooldownUntil - now) / 1000) };
    }
    return {
      key,
      status: "available",
      config: { url: providerConfig.url, model: providerConfig.model, apiKey, providerKey: key },
    };
  });
}

function formatUnavailableProvidersError(candidates: ProviderCandidate[]): string {
  const details = candidates
    .filter((c): c is Exclude<ProviderCandidate, { status: "available" }> => c.status !== "available")
    .map((c) =>
      c.status === "no-key"
        ? `${c.key}: no ${AI_PROVIDERS[c.key].keyVar} configured`
        : `${c.key}: recovers in ${c.recoversInSecs}s`,
    );
  return `All AI providers unavailable — ${details.join("; ")}`;
}

export function getAIConfig(): AiConfig {
  const candidates = evaluateProviderCandidates();
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
  const errorBody = (
    Array.isArray(lastErrorData) ? lastErrorData[0] : lastErrorData
  ) as Record<string, unknown>;
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
  // reset). NOT verified for OpenRouter or Gemini — confirm their actual 429
  // response shape (header vs. body message; per-minute vs. per-day/quota
  // wording) against the live APIs before trusting this default to
  // distinguish a short rate limit from a full quota exhaustion for those two.
  // Because it's unverified for two of three providers, callers must not treat
  // it as confident: it must not justify a fail-fast decision or a recorded
  // provider cooldown, only a single in-process retry sleep.
  return { delaySecs: 10, isConfident: false };
}

export const MAX_RETRIES = 2;
export const TOTAL_TIMEOUT_MS = 45_000;

function truncate(text: string, limit = 200): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export async function aiJSON(
  aiConfig: AiConfig,
  label: string,
  systemMessage: string,
  userMessage: string,
  maxTokens: number,
): Promise<unknown> {
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
          markProviderExhausted(aiConfig.providerKey, Date.now() + delaySecs * 1000);
          throw new Error(
            `AI rate limited (${label}): provider asks to retry in ${delaySecs}s, exceeds ${TOTAL_TIMEOUT_MS / 1000}s budget`,
          );
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
    if (apiResponse.status === 429) {
      const { delaySecs, isConfident } = parseRetryDelaySeconds(
        apiResponse,
        extractRetryMessage(lastErrorData),
      );
      if (isConfident) {
        markProviderExhausted(aiConfig.providerKey, Date.now() + delaySecs * 1000);
      }
    }
    const errorBody = (Array.isArray(lastErrorData) ? lastErrorData[0] : lastErrorData) as Record<
      string,
      unknown
    >;
    const errorMessage =
      (errorBody?.error as Record<string, unknown>)?.message ??
      errorBody?.message ??
      JSON.stringify(lastErrorData);
    throw new Error(
      `AI error (${label}) [${apiResponse.status}]: ${errorMessage || apiResponse.statusText}`,
    );
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
    return JSON.parse(stripped);
  } catch {
    throw new Error(`AI parse error (${label}): ${stripped.slice(0, 200)}`);
  }
}
