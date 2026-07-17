// Shared TradeMe category-discovery logic — turns a natural-language prompt into a
// set of category slugs via an embedding pre-filter followed by a single AI call.
// TradeMe's category taxonomy is the same regardless of which recipe later turns a
// slug into a URL (modern `/a/marketplace/` path vs legacy `cid`/`rptpath`), so this
// stays independent of any URL-building concern.
import type { AiConfig } from '../../lib/recipes/base';
import { aiJSON, applyAiJsonResult } from '../ai';
import { type CategoryWithEmbeddingRow, getDb, stmtGetAllCategoriesWithEmbeddings } from '../db';
import { cosineSimilarity, embedTextAsync } from '../embeddings';

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

export function rankCategoriesBySimilarity(
  categories: CategoryWithEmbeddingRow[],
  promptEmbedding: number[],
  shortlistSize: number
): ShortlistedCategory[] {
  return categories
    .filter(
      (category): category is CategoryWithEmbeddingRow & { embedding: string } =>
        category.embedding !== null
    )
    .map((category) => ({
      slug: category.slug,
      display: category.display,
      similarity: cosineSimilarity(promptEmbedding, JSON.parse(category.embedding) as number[]),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, shortlistSize)
    .map(({ slug, display }) => ({ slug, display }));
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
  const allCategories = stmtGetAllCategoriesWithEmbeddings(database).all();
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
