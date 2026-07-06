// Server-side only — AI provider configuration and JSON completion helper.

import type { AiConfig } from "../lib/recipes/base";
import type { AiAuditEntry } from "./aiAuditLog";
import { recordAiAuditEntry } from "./aiAuditLog";

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

export function getAIConfig(): AiConfig {
  const provider = (process.env.AI_PROVIDER ?? "groq").toLowerCase();
  const providerConfig = AI_PROVIDERS[provider];
  if (!providerConfig)
    throw new Error(`Unknown AI_PROVIDER "${provider}" — use groq, openrouter, or gemini`);
  const apiKey = process.env[providerConfig.keyVar];
  if (!apiKey) throw new Error(`${providerConfig.keyVar} is not set`);
  return { url: providerConfig.url, model: providerConfig.model, apiKey };
}

type OpenAIResponseShape = { choices?: Array<{ message?: { content?: string } }> };

function parseRetryDelaySeconds(response: Response, errorMessage: string): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const parsed = Number.parseFloat(header);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const match = errorMessage.match(/try again in (\d+\.?\d*)s/i);
  if (match) return Number.parseFloat(match[1]);
  return 10;
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

export async function aiJSON(
  aiConfig: AiConfig,
  label: string,
  systemMessage: string,
  userMessage: string,
  maxTokens: number,
): Promise<unknown> {
  console.log(`[AI] ${label} → calling model: ${aiConfig.model}`);

  const auditContext = { label, model: aiConfig.model, systemMessage, userMessage };
  const recordAttempt = (overrides: AuditEntryOverrides) =>
    recordAiAuditEntry(buildAuditEntry(auditContext, overrides));

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

        if (apiResponse.status === 429 && attempt <= MAX_RETRIES) {
          const delaySecs = parseRetryDelaySeconds(apiResponse, bodyMessage ?? "");
          recordAttempt({
            attempt,
            status: "rate_limited",
            httpStatus: 429,
            errorMessage: bodyMessage ?? "",
            durationMs: Date.now() - attemptStartedAt,
          });
          console.warn(`[AI] ${label} → rate limited, retrying in ${delaySecs}s`);
          await new Promise<void>((resolve) => setTimeout(resolve, delaySecs * 1000));
          continue;
        }

        const errorMessage = bodyMessage || apiResponse.statusText || JSON.stringify(lastErrorData);
        recordAttempt({
          attempt,
          status: "http_error",
          httpStatus: apiResponse.status,
          errorMessage,
          durationMs: Date.now() - attemptStartedAt,
        });
        throw new Error(`AI error (${label}) [${apiResponse.status}]: ${errorMessage}`);
      }

      const responseData = (await apiResponse.json()) as OpenAIResponseShape;
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
        return result;
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
