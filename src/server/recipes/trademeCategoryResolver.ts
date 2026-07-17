// Shared TradeMe category-discovery logic — turns a natural-language prompt into a
// set of category slugs via an embedding pre-filter followed by a single AI call.
// TradeMe's category taxonomy is the same regardless of which recipe later turns a
// slug into a URL (modern `/a/marketplace/` path vs legacy `cid`/`rptpath`), so this
// stays independent of any URL-building concern.
import type Database from 'better-sqlite3';
import type { AiConfig } from '../../lib/recipes/base';
import { aiJSON, applyAiJsonResult } from '../ai';
import { type CategoryWithEmbeddingRow, getDb, stmtGetAllCategoriesWithEmbeddings } from '../db';
import { cosineSimilarity, EMBEDDING_MODEL, embedTextAsync } from '../embeddings';

export type DiscoverEntry = { slug: string; searchString: string | null };

// Size of the embedding-ranked shortlist fed into the single AI call. The one parameter
// that genuinely needs empirical tuning against real prompts post-implementation — too
// low risks missing legitimate matches, too high reintroduces the over-inclusion problem
// this design exists to avoid.
const SHORTLIST_SIZE = 40;

export const CATEGORY_SYSTEM_PROMPT =
  'You are a TradeMe NZ shopping assistant. From the candidate categories below pick all categories where this item plausibly appears — err on the side of more coverage. Use a deep specific category when the user wants a particular brand/model, or a broader one when they want any item of that type. Never pick both a category and one of its subcategories — always choose the single most appropriate depth. Return JSON: { "categories": [{ "slug": string, "searchString": string | null }] }. Each slug must be a value shown in parentheses. For searchString: use the product name only — no chip names, RAM, year, storage size, or any other specs. If the category already names the item type, use null. Examples: category=bookshelves → null; category=bedroom-furniture/other, item=bookshelf → searchString=\'bookshelf\'; category=apple-laptops, user wants \'Apple MacBook Pro M1 16gb 2021\' → searchString=\'macbook pro\'.';

export function collapseEntries(allEntries: DiscoverEntry[]): DiscoverEntry[] {
  const allSlugs = new Set(allEntries.map((e) => e.slug));
  const collapsed: DiscoverEntry[] = [];
  const consumed = new Set<string>();

  for (const entry of allEntries) {
    if (consumed.has(entry.slug)) continue;
    const parentSlug = entry.slug.split('/').slice(0, -1).join('/');
    if (allSlugs.has(parentSlug)) continue;
    const siblings = allEntries.filter(
      (e) =>
        e !== entry &&
        e.slug.split('/').slice(0, -1).join('/') === parentSlug &&
        e.searchString === entry.searchString
    );
    // Collapse siblings only when the shared parent is at least 3 segments deep
    // (e.g. marketplace/computers/laptops) to avoid collapsing into a bare top-level slug.
    const MIN_COLLAPSIBLE_PARENT_DEPTH = 3;
    if (
      siblings.length >= 1 &&
      parentSlug &&
      parentSlug.split('/').length >= MIN_COLLAPSIBLE_PARENT_DEPTH
    ) {
      for (const sibling of siblings) consumed.add(sibling.slug);
      consumed.add(entry.slug);
      collapsed.push({ slug: parentSlug, searchString: entry.searchString });
    } else {
      collapsed.push(entry);
    }
  }
  return collapsed;
}

type ShortlistedCategory = { slug: string; display: string };

// A categories-with-embeddings row with its embedding already parsed out of the JSON text
// column — see loadCategoryEmbeddingsCache below, which parses each row exactly once.
export type CachedCategoryEmbedding = { slug: string; display: string; embedding: number[] | null };

export function rankCategoriesBySimilarity(
  categories: CachedCategoryEmbedding[],
  promptEmbedding: number[],
  shortlistSize: number
): ShortlistedCategory[] {
  return categories
    .filter(
      (category): category is CachedCategoryEmbedding & { embedding: number[] } =>
        category.embedding !== null
    )
    .map((category) => ({
      slug: category.slug,
      display: category.display,
      similarity: cosineSimilarity(promptEmbedding, category.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, shortlistSize)
    .map(({ slug, display }) => ({ slug, display }));
}

// ── In-process categories-with-embeddings cache ────────────────────────────────
// `trademe_categories` only changes via the offline scripts/import-categories.ts and
// scripts/embed-categories.ts jobs — never from a user-facing write — so re-reading and
// re-JSON.parse-ing the full table on every discover request is pure waste (PR #41 review,
// Backend finding #2). This module-level cache is lazily populated on first use (no work at
// import time) and holds the parsed embedding vectors so JSON.parse only ever runs once per
// row. Call invalidateCategoryEmbeddingsCache() to force the next call to re-read the DB —
// e.g. after running the backfill script against a live server, or from a future check that
// needs to see current (not cached) embedded/total counts.
let categoryEmbeddingsCache: CachedCategoryEmbedding[] | null = null;

// A row is treated as unembedded (excluded from ranking, same as a null embedding) if:
// - it has no stored vector yet, or
// - its embedding_model doesn't match the current EMBEDDING_MODEL — a stale-model vector
//   must never be compared against a current-model prompt embedding, even if dimensions
//   happen to coincide (PR #41 review, Data #3 / QA #2, expanded to cover model swaps), or
// - its stored JSON is malformed — a single corrupt row must not crash the whole request
//   (PR #41 review, Data #3).
function parseCategoryEmbeddingRow(row: CategoryWithEmbeddingRow): CachedCategoryEmbedding {
  if (row.embedding === null || row.embedding_model !== EMBEDDING_MODEL) {
    return { slug: row.slug, display: row.display, embedding: null };
  }
  try {
    return {
      slug: row.slug,
      display: row.display,
      embedding: JSON.parse(row.embedding) as number[],
    };
  } catch {
    console.warn(
      `[trademeCategoryResolver] malformed embedding JSON for category ${row.slug} — skipping`
    );
    return { slug: row.slug, display: row.display, embedding: null };
  }
}

function loadCategoryEmbeddingsCache(database: Database.Database): CachedCategoryEmbedding[] {
  if (categoryEmbeddingsCache === null) {
    categoryEmbeddingsCache = stmtGetAllCategoriesWithEmbeddings(database)
      .all()
      .map(parseCategoryEmbeddingRow);
  }
  return categoryEmbeddingsCache;
}

export function invalidateCategoryEmbeddingsCache(): void {
  categoryEmbeddingsCache = null;
}

type SelectedCategory = { slug: string; searchString?: string | null };

export async function resolveDiscoverCategoriesAsync(
  prompt: string,
  getAiConfig: () => AiConfig
): Promise<{ entries: DiscoverEntry[]; warnings: string[] }> {
  const database = getDb();
  let promptEmbedding: number[];
  try {
    promptEmbedding = await embedTextAsync(prompt.trim());
  } catch (error) {
    // embedTextAsync has no retry/multi-provider fallback (see embeddings.ts) — wrap so a
    // Gemini failure surfaces as a diagnosable, discover-scoped error rather than a raw
    // provider message, consistent with the other thrown errors in this function. The
    // caller (buildDiscoverUrlsAsync -> discoverCategoriesAsync's Promise.allSettled)
    // already keeps this from crashing the whole discover request.
    throw new Error(`discover: category embedding unavailable — ${(error as Error).message}`, {
      cause: error,
    });
  }
  const allCategories = loadCategoryEmbeddingsCache(database);
  const shortlist = rankCategoriesBySimilarity(allCategories, promptEmbedding, SHORTLIST_SIZE);
  if (shortlist.length === 0) throw new Error('no embedded categories available for discovery');

  const candidateList = shortlist
    .map((category) => `${category.display} (slug: ${category.slug})`)
    .join('\n');

  // 1536 output tokens: response is a JSON array of up to SHORTLIST_SIZE slug+searchString
  // pairs — comfortably fits within this budget.
  const aiConfig = getAiConfig();
  const result = applyAiJsonResult(
    aiConfig.cooldownStore,
    await aiJSON(
      aiConfig,
      'discover-categories',
      CATEGORY_SYSTEM_PROMPT,
      `I'm looking for: ${prompt.trim()}\n\nCandidate categories:\n${candidateList}`,
      1536
    )
  ) as Record<string, unknown> | null;
  if (result === null || !Array.isArray(result.categories))
    throw new Error('discover: expected object response with categories array');

  const rawCategories = result.categories as SelectedCategory[];
  const validSlugs = new Set(shortlist.map((category) => category.slug));
  const allEntries: DiscoverEntry[] = rawCategories
    .filter((category) => validSlugs.has(category.slug))
    .map((category) => ({ slug: category.slug, searchString: category.searchString ?? null }));

  const warnings: string[] = [];
  if (allEntries.length < rawCategories.length) {
    const unrecognised = rawCategories
      .filter((category) => !validSlugs.has(category.slug))
      .map((category) => category.slug);
    warnings.push(`unrecognised categories ignored: ${unrecognised.join(', ')}`);
  }

  const entries = collapseEntries(allEntries);
  if (entries.length === 0) throw new Error('AI returned no valid categories');
  return { entries, warnings };
}
