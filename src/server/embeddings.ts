// Server-side only — Gemini embeddings client used to pre-filter TradeMe categories
// before the single AI category-selection call in trademeCategoryResolver.ts.
// Reuses GEMINI_API_KEY (already configured for chat completions in ai.ts); embeddings
// are Gemini-specific, so unlike aiJSON there is no multi-provider fallback here.

export const EMBEDDING_MODEL = 'gemini-embedding-2';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Gemini's docs don't publish a documented per-request cap for batchEmbedContents —
// chunk defensively rather than assume an arbitrary caller's full text list fits in
// one request.
const BATCH_CHUNK_SIZE = 100;

function requireGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error('GEMINI_API_KEY is not set — category-discovery embeddings require it');
  return apiKey;
}

type EmbedContentResponse = { embedding?: { values?: number[] } };
type BatchEmbedContentsResponse = { embeddings?: Array<{ values?: number[] }> };

export async function embedTextAsync(text: string): Promise<number[]> {
  const apiKey = requireGeminiApiKey();
  const response = await fetch(`${API_BASE}/${EMBEDDING_MODEL}:embedContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini embedContent failed [${response.status}]: ${body}`);
  }
  const data = (await response.json()) as EmbedContentResponse;
  if (!data.embedding?.values) {
    throw new Error('Gemini embedContent: malformed response, missing embedding.values');
  }
  return data.embedding.values;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// The backfill script (scripts/embed-categories.ts) is the only caller of this path, and
// it's a one-time offline job, not a live request — unlike `embedTextAsync` (used at
// discover request-time, which must fail fast with no retry per the "no fallback" design
// decision), retrying here just paces the job to Gemini's free-tier per-minute quota
// instead of aborting the whole backfill on the first 429.
const MAX_BATCH_RETRIES = 10;
const DEFAULT_RETRY_DELAY_SECS = 20;
// Added on top of Gemini's own reported retry delay so a retry doesn't land right on the
// edge of the quota window and immediately 429 again.
const RETRY_DELAY_SAFETY_MARGIN_SECS = 2;

function parseGeminiRetryDelaySeconds(errorBody: string): number | null {
  try {
    const parsed = JSON.parse(errorBody) as {
      error?: { details?: Array<{ '@type'?: string; retryDelay?: string }> };
    };
    const retryInfo = parsed.error?.details?.find(
      (detail) => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
    );
    const match = retryInfo?.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/);
    return match ? Number.parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

// Gemini's free tier enforces both a per-minute quota (worth pacing/retrying against) and
// a per-day quota (retrying is futile — it doesn't reset for up to 24h). Both surface as a
// 429 with the same shape, distinguished only by the violated quotaId, so this must be
// checked before deciding whether a retry can ever succeed.
function isDailyQuotaExhausted(errorBody: string): boolean {
  try {
    const parsed = JSON.parse(errorBody) as {
      error?: { details?: Array<{ '@type'?: string; violations?: Array<{ quotaId?: string }> }> };
    };
    const quotaFailure = parsed.error?.details?.find(
      (detail) => detail['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure'
    );
    return (
      quotaFailure?.violations?.some((violation) => violation.quotaId?.includes('PerDay')) ?? false
    );
  } catch {
    return false;
  }
}

async function embedTextsChunkAsync(
  texts: string[],
  apiKey: string,
  attempt = 1
): Promise<number[][]> {
  const response = await fetch(`${API_BASE}/${EMBEDDING_MODEL}:batchEmbedContents`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
      })),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 429 && isDailyQuotaExhausted(body)) {
      throw new Error(
        `Gemini batchEmbedContents failed [429]: daily free-tier quota exhausted — re-run this backfill after the quota resets (embedded rows are already persisted, so it resumes from where it left off): ${body}`
      );
    }
    if (response.status === 429 && attempt <= MAX_BATCH_RETRIES) {
      const delaySecs =
        (parseGeminiRetryDelaySeconds(body) ?? DEFAULT_RETRY_DELAY_SECS) +
        RETRY_DELAY_SAFETY_MARGIN_SECS;
      console.warn(
        `[embeddings] batchEmbedContents rate limited, retrying in ${delaySecs}s (attempt ${attempt}/${MAX_BATCH_RETRIES})`
      );
      await new Promise((resolve) => setTimeout(resolve, delaySecs * 1000));
      return embedTextsChunkAsync(texts, apiKey, attempt + 1);
    }
    throw new Error(`Gemini batchEmbedContents failed [${response.status}]: ${body}`);
  }
  const data = (await response.json()) as BatchEmbedContentsResponse;
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error('Gemini batchEmbedContents: malformed response, embeddings count mismatch');
  }
  return data.embeddings.map((embedding) => {
    if (!embedding.values) throw new Error('Gemini batchEmbedContents: entry missing values');
    return embedding.values;
  });
}

export async function embedTextsBatchAsync(texts: string[]): Promise<number[][]> {
  const apiKey = requireGeminiApiKey();
  const results: number[][] = [];
  for (const batch of chunkItems(texts, BATCH_CHUNK_SIZE)) {
    results.push(...(await embedTextsChunkAsync(batch, apiKey)));
  }
  return results;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
