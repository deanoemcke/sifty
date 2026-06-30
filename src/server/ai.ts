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

export function getAIConfig(): AiConfig {
  const provider = (process.env.AI_PROVIDER ?? "groq").toLowerCase();
  const providerConfig = AI_PROVIDERS[provider];
  if (!providerConfig) throw new Error(`Unknown AI_PROVIDER "${provider}" — use groq, openrouter, or gemini`);
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

export async function aiJSON(
  aiConfig: AiConfig,
  label: string,
  systemMessage: string,
  userMessage: string,
  maxTokens: number,
  logUserMessage?: string,
): Promise<unknown> {
  console.log(
    `[AI] ${label} → model: ${aiConfig.model}\n[system] ${systemMessage}\n[user] ${logUserMessage ?? userMessage}`,
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
  const MAX_RETRIES = 2;
  let apiResponse: Response | undefined;
  let lastErrorData: Record<string, unknown> = {};
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
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
        const errorBody = (Array.isArray(lastErrorData) ? lastErrorData[0] : lastErrorData) as Record<string, unknown>;
        const errorMessage = String((errorBody?.error as Record<string, unknown>)?.message ?? errorBody?.message ?? "");
        const delaySecs = parseRetryDelaySeconds(apiResponse, errorMessage);
        console.warn(`[AI] ${label} → rate limited, retrying in ${delaySecs}s`);
        await new Promise<void>((resolve) => setTimeout(resolve, delaySecs * 1000));
        continue;
      }
      break;
    }
    break;
  }
  if (apiResponse === undefined) throw new Error(`AI request failed: no response received (${label})`);
  if (!apiResponse.ok) {
    const errorBody = (Array.isArray(lastErrorData) ? lastErrorData[0] : lastErrorData) as Record<string, unknown>;
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
