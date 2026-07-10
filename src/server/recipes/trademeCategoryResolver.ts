// Shared TradeMe category-discovery logic — turns a natural-language prompt into a
// set of category slugs via a two-step AI pipeline. TradeMe's category taxonomy is the
// same regardless of which recipe later turns a slug into a URL (modern `/a/marketplace/`
// path vs legacy `cid`/`rptpath`), so this stays independent of any URL-building concern.
import type { AiConfig } from '../../lib/recipes/base';
import { aiJSON, applyAiJsonResult } from '../ai';
import type { CategoryRow } from '../db';
import { getDb, stmtGetCategoriesAtDepth2, stmtGetCategoriesByTop2 } from '../db';

export type DiscoverEntry = { slug: string; searchString: string | null };

export const STEP1_SYSTEM_PROMPT =
  'You are a TradeMe NZ shopping assistant. From the category list below, pick the 1–3 categories where this item would most likely be listed for sale. Also suggest a short label for the search and a search query. Return JSON: { "categories": string[], "searchLabel": string, "searchQuery": string | null } using the exact category names from the list. For searchLabel: a short human-readable label for the search (e.g. "MacBook Pro laptops"). For searchQuery: use the product name only — no chip names, RAM, year, storage size, or any other specs. If the category already names the item type, use null. Examples: category=bookshelves → null; category=apple-laptops, user wants \'Apple MacBook Pro M1 16gb 2021\' → searchQuery=\'macbook pro\'.';

export const STEP2_SYSTEM_PROMPT =
  'You are a TradeMe NZ shopping assistant. From the categories below pick all subcategories where this item plausibly appears — err on the side of more coverage. Use a deep specific category when the user wants a particular brand/model, or a broader one when they want any item of that type. Never pick both a category and one of its subcategories — always choose the single most appropriate depth. Return JSON: { "categories": [{ "slug": string, "searchString": string | null }] }. Each slug must be a value shown in parentheses. For searchString: rule: use the product name only — no chip names, RAM, year, storage size, or any other specs. If the category already names the item type, use null. Examples: category=bookshelves → null; category=bedroom-furniture/other, item=bookshelf → searchString=\'bookshelf\'; category=apple-laptops, user wants \'Apple MacBook Pro M1 16gb 2021\' → searchString=\'macbook pro\'.';

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

type Step2Category = { slug: string; searchString?: string | null };

export async function resolveDiscoverCategoriesAsync(
  prompt: string,
  getAiConfig: () => AiConfig
): Promise<{ entries: DiscoverEntry[]; warnings: string[] }> {
  const database = getDb();
  const broad = stmtGetCategoriesAtDepth2(database).all();
  const broadDisplayList = broad.map((category) => category.display).join('\n');

  // 512 output tokens: step-1 returns a tiny JSON object (3 string fields) — input size (~3 k tokens for 392 categories) is unlimited by this parameter.
  const step1AiConfig = getAiConfig();
  const broadCategoryPick = applyAiJsonResult(
    step1AiConfig.cooldownStore,
    await aiJSON(
      step1AiConfig,
      'step1',
      STEP1_SYSTEM_PROMPT,
      `I'm looking for: ${prompt.trim()}\n\nAvailable categories:\n${broadDisplayList}`,
      512
    )
  ) as Record<string, unknown> | null;
  if (typeof broadCategoryPick !== 'object' || broadCategoryPick === null)
    throw new Error('discover step1: expected object response');
  const rawCategories = (
    Array.isArray(broadCategoryPick.categories) ? broadCategoryPick.categories : []
  ) as string[];
  const selectedBroadSlugs: string[] = rawCategories
    .map((display: string) => broad.find((category) => category.display === display)?.slug)
    .filter((slug): slug is string => !!slug);
  if (selectedBroadSlugs.length === 0) throw new Error('AI returned no valid broad categories');
  const step1Warnings: string[] = [];
  if (selectedBroadSlugs.length < rawCategories.length) {
    const unrecognised = rawCategories.filter(
      (display: string) => !broad.some((category) => category.display === display)
    );
    step1Warnings.push(`step1: unrecognised categories ignored: ${unrecognised.join(', ')}`);
  }

  // Sequential (not parallel) so concurrent bursts don't collide on the provider's TPM limit.
  const subcategoryPickResults: Array<{
    top2Slug: string;
    candidates: CategoryRow[];
    result: Record<string, unknown> | null;
  }> = [];
  for (const top2Slug of selectedBroadSlugs) {
    const broadEntry = broad.find((category) => category.slug === top2Slug);
    if (!broadEntry) throw new Error(`invariant: slug ${top2Slug} not found in broad categories`);
    const candidates = stmtGetCategoriesByTop2(database).all(top2Slug);
    const specificList = candidates
      .map((category) => `${category.display} (slug: ${category.slug})`)
      .join('\n');
    // 1024 output tokens: step-2 returns a JSON array of slug+searchString pairs; a broad category can have dozens of subcategories, so 1024 gives headroom over step-1's 512.
    // Re-resolved fresh per iteration (not hoisted) so a 429 on an earlier slug
    // actually rotates to the next live provider for the remaining slugs.
    const step2AiConfig = getAiConfig();
    const result = applyAiJsonResult(
      step2AiConfig.cooldownStore,
      await aiJSON(
        step2AiConfig,
        `step2:${top2Slug}`,
        STEP2_SYSTEM_PROMPT,
        `I'm looking for: ${prompt.trim()}\n\nCategories within "${broadEntry.display}":\n${specificList}`,
        1024
      )
    );
    subcategoryPickResults.push({
      top2Slug,
      candidates,
      result: result as Record<string, unknown> | null,
    });
  }

  const allEntries: DiscoverEntry[] = [];
  const warnings: string[] = [];
  for (const { top2Slug, candidates, result } of subcategoryPickResults) {
    const validSlugs = new Set(candidates.map((category) => category.slug));
    if (result === null || !Array.isArray(result.categories)) {
      warnings.push(`step2:${top2Slug} unexpected result`);
      continue;
    }
    for (const category of (result.categories as Step2Category[]).filter((category) =>
      validSlugs.has(category.slug)
    )) {
      allEntries.push({ slug: category.slug, searchString: category.searchString ?? null });
    }
  }

  const entries = collapseEntries(allEntries);
  if (entries.length === 0) throw new Error('AI returned no valid specific categories');
  return { entries, warnings: [...step1Warnings, ...warnings] };
}
