import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConfig, ProviderCooldownStore } from '../../lib/recipes/base';

let _testDb: Database.Database | null = null;

function requireTestDb(): Database.Database {
  if (!_testDb) throw new Error('test DB not initialised');
  return _testDb;
}

// Mirrors the `../db` mocking pattern used in quickSearch.test.ts — keeps every
// real export (initSchema, the prepared statements, ...) via `importOriginal`
// and only swaps `getDb` for an in-memory instance seeded per-test.
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, getDb: () => requireTestDb() };
});

// Only `aiJSON` is faked — `applyAiJsonResult` stays real so the ok/rate-limited
// unwrap logic under test is the actual implementation, not a re-encoding of it.
vi.mock('../ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai')>();
  return { ...actual, aiJSON: vi.fn() };
});

// Only `embedTextAsync` is faked — `cosineSimilarity` stays real so ranking
// behaviour under test is the actual implementation.
vi.mock('../embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../embeddings')>();
  return { ...actual, embedTextAsync: vi.fn() };
});

import { aiJSON } from '../ai';
import { initSchema } from '../db';
import { EMBEDDING_MODEL, embedTextAsync } from '../embeddings';
import {
  assertCategoryEmbeddingCoverage,
  CATEGORY_SYSTEM_PROMPT,
  type CachedCategoryEmbedding,
  collapseEntries,
  type DiscoverEntry,
  invalidateCategoryEmbeddingsCache,
  rankCategoriesBySimilarity,
  resolveDiscoverCategoriesAsync,
} from './trademeCategoryResolver';

describe('CATEGORY_SYSTEM_PROMPT', () => {
  it('contains the required JSON schema keywords for the AI response contract', () => {
    expect(CATEGORY_SYSTEM_PROMPT).toContain('"categories"');
    expect(CATEGORY_SYSTEM_PROMPT).toContain('"slug"');
    expect(CATEGORY_SYSTEM_PROMPT).toContain('"searchString"');
  });

  it('instructs the AI to return JSON', () => {
    expect(CATEGORY_SYSTEM_PROMPT).toContain('Return JSON');
  });
});

// ── collapseEntries ───────────────────────────────────────────────────────────

function entry(slug: string, searchString = 'item'): DiscoverEntry {
  return { slug, searchString };
}

describe('collapseEntries', () => {
  it('returns an empty array unchanged', () => {
    expect(collapseEntries([])).toEqual([]);
  });

  it('passes through a single entry with no siblings', () => {
    const input = [entry('computers/laptops/apple')];
    expect(collapseEntries(input)).toEqual(input);
  });

  it('drops a child when its parent is also present in the list', () => {
    const input = [entry('computers/laptops'), entry('computers/laptops/apple')];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('computers/laptops');
  });

  it('collapses two siblings with the same searchString to their parent', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'macbook'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ slug: 'marketplace/computers/laptops', searchString: 'macbook' });
  });

  it('does not collapse siblings when their shared parent slug has fewer than 3 segments', () => {
    const input = [
      entry('computers/laptops/apple', 'macbook'),
      entry('computers/laptops/dell', 'macbook'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
  });

  it('does not collapse siblings with different searchStrings', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'latitude'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
  });

  it('does not collapse a lone entry with no siblings', () => {
    const input = [entry('marketplace/computers/laptops/apple', 'macbook')];
    expect(collapseEntries(input)).toEqual(input);
  });

  it('collapses three siblings to one parent entry', () => {
    const input = [
      entry('marketplace/computers/laptops/apple'),
      entry('marketplace/computers/laptops/dell'),
      entry('marketplace/computers/laptops/lenovo'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ slug: 'marketplace/computers/laptops', searchString: 'item' });
  });

  it('collapses one sibling group and leaves unrelated entries untouched', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'macbook'),
      entry('marketplace/electronics/cameras/dslr'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
    const slugs = result.map((e) => e.slug);
    expect(slugs).toContain('marketplace/computers/laptops');
    expect(slugs).toContain('marketplace/electronics/cameras/dslr');
  });

  it('does not emit the collapsed parent slug twice when three siblings collapse', () => {
    const input = [
      entry('marketplace/furniture/home/bedroom'),
      entry('marketplace/furniture/home/living'),
      entry('marketplace/furniture/home/dining'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('marketplace/furniture/home');
  });

  it('does not collapse siblings when their parent is present in the input', () => {
    const input = [
      entry('marketplace/furniture/home'),
      entry('marketplace/furniture/home/bedroom'),
      entry('marketplace/furniture/home/living'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('marketplace/furniture/home');
  });

  it('collapses two independent sibling groups under separate parents without merging them', () => {
    // Regression guard: collapsing siblings in one group must not affect siblings in an
    // unrelated group that shares no ancestor. Each group produces its own parent entry.
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'macbook'),
      entry('marketplace/furniture/home/bedroom'),
      entry('marketplace/furniture/home/living'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
    const slugs = result.map((e) => e.slug);
    expect(slugs).toContain('marketplace/computers/laptops');
    expect(slugs).toContain('marketplace/furniture/home');
    const laptops = result.find((e) => e.slug === 'marketplace/computers/laptops');
    const home = result.find((e) => e.slug === 'marketplace/furniture/home');
    expect(laptops?.searchString).toBe('macbook');
    expect(home?.searchString).toBe('item');
  });
});

// ── rankCategoriesBySimilarity ─────────────────────────────────────────────

function embeddedCategory(
  slug: string,
  display: string,
  embedding: number[] | null
): CachedCategoryEmbedding {
  return { slug, display, embedding };
}

describe('rankCategoriesBySimilarity', () => {
  it('sorts by similarity descending and truncates to the shortlist size', () => {
    const categories = [
      embeddedCategory('a', 'A', [1, 0]),
      embeddedCategory('b', 'B', [0.9, 0.1]),
      embeddedCategory('c', 'C', [0, 1]),
    ];
    const result = rankCategoriesBySimilarity(categories, [1, 0], 2);
    expect(result.map((c) => c.slug)).toEqual(['a', 'b']);
  });

  it('excludes categories with a null embedding', () => {
    const categories = [embeddedCategory('a', 'A', [1, 0]), embeddedCategory('b', 'B', null)];
    const result = rankCategoriesBySimilarity(categories, [1, 0], 10);
    expect(result.map((c) => c.slug)).toEqual(['a']);
  });
});

// ── resolveDiscoverCategoriesAsync ─────────────────────────────────────────

const STUB_COOLDOWN_STORE: ProviderCooldownStore = {
  markExhausted: () => {},
  getCooldownUntil: () => undefined,
};

const MOCK_AI_CONFIG: AiConfig = {
  url: 'http://example.com',
  model: 'mock-model',
  apiKey: 'key',
  providerKey: 'mock',
  cooldownStore: STUB_COOLDOWN_STORE,
};

type SeedCategory = {
  slug: string;
  display: string;
  depth: number;
  parentSlug: string | null;
  embedding: number[];
  embeddingModel?: string;
};

function seedCategories(db: Database.Database, categories: SeedCategory[]): void {
  const insert = db.prepare(
    'INSERT INTO trademe_categories (slug, display, depth, parent_slug, legacy_path, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const category of categories) {
    insert.run(
      category.slug,
      category.display,
      category.depth,
      category.parentSlug,
      `legacy/${category.slug}`,
      JSON.stringify(category.embedding),
      category.embeddingModel ?? EMBEDDING_MODEL
    );
  }
}

// Reproduces the reported bug: with the old two-step design, step 1 had to guess a
// broad bucket ("Tools") before ever seeing "Ladders", so the correct leaf — which
// lives under a completely different branch ("Building supplies") — was structurally
// unreachable except via a literal keyword-match coincidence. With the embedding
// pre-filter there is no broad-bucket guess: "ladder" embeds close to the leaf and its
// ancestor regardless of which top-level branch they sit under, so both surface
// directly in the shortlist passed to the single AI call.
function seedLadderBugFixture(db: Database.Database): void {
  seedCategories(db, [
    {
      slug: 'building-renovation/tools',
      display: 'Building & renovation > Tools',
      depth: 2,
      parentSlug: 'building-renovation',
      embedding: [0, 1],
    },
    {
      slug: 'building-renovation/tools/hand-tools',
      display: 'Building & renovation > Tools > Hand tools',
      depth: 3,
      parentSlug: 'building-renovation/tools',
      embedding: [0, 1],
    },
    {
      slug: 'building-renovation/building-supplies',
      display: 'Building & renovation > Building supplies',
      depth: 2,
      parentSlug: 'building-renovation',
      embedding: [0.2, 0.8],
    },
    {
      slug: 'building-renovation/building-supplies/scaffolding-ladders',
      display: 'Building & renovation > Building supplies > Scaffolding & ladders',
      depth: 3,
      parentSlug: 'building-renovation/building-supplies',
      embedding: [0.9, 0.1],
    },
    {
      slug: 'building-renovation/building-supplies/scaffolding-ladders/ladders',
      display: 'Building & renovation > Building supplies > Scaffolding & ladders > Ladders',
      depth: 4,
      parentSlug: 'building-renovation/building-supplies/scaffolding-ladders',
      embedding: [1, 0],
    },
  ]);
}

function aiJsonOk(value: unknown) {
  return { kind: 'ok' as const, value };
}

describe('resolveDiscoverCategoriesAsync', () => {
  // The categories-with-embeddings table is now cached at module scope (see
  // loadCategoryEmbeddingsCache in trademeCategoryResolver.ts) — each test below seeds a
  // fresh in-memory DB, so the cache from a previous test must not leak into the next one.
  beforeEach(() => {
    invalidateCategoryEmbeddingsCache();
  });

  it('surfaces the ladders branch directly via the embedding shortlist, with a single AI call and no broad-bucket guess', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({
        categories: [
          {
            slug: 'building-renovation/building-supplies/scaffolding-ladders',
            searchString: null,
          },
        ],
      })
    );

    const { entries } = await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    expect(entries.map((e) => e.slug)).toContain(
      'building-renovation/building-supplies/scaffolding-ladders'
    );
    expect(vi.mocked(aiJSON)).toHaveBeenCalledTimes(1);
    // The candidate list handed to the single AI call includes both branches — proof
    // the embedding shortlist isn't gated behind a wrong broad-bucket pick.
    const [, , , userMessage] = vi.mocked(aiJSON).mock.calls[0];
    expect(userMessage).toContain('Building & renovation > Tools');
    expect(userMessage).toContain('Scaffolding & ladders');
  });

  it('filters out AI-hallucinated slugs not present in the shortlist and warns', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({
        categories: [
          {
            slug: 'building-renovation/building-supplies/scaffolding-ladders',
            searchString: null,
          },
          { slug: 'not-a-real-category', searchString: null },
        ],
      })
    );

    const { entries, warnings } = await resolveDiscoverCategoriesAsync(
      'ladder',
      () => MOCK_AI_CONFIG
    );

    expect(entries.map((e) => e.slug)).toEqual([
      'building-renovation/building-supplies/scaffolding-ladders',
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not-a-real-category');
  });

  it('throws when the AI selects zero valid categories', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    vi.mocked(aiJSON).mockResolvedValueOnce(aiJsonOk({ categories: [] }));

    await expect(resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG)).rejects.toThrow(
      'AI returned no valid categories'
    );
  });

  it('throws when no categories in the DB have an embedding yet', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedCategories(db, [
      {
        slug: 'building-renovation/tools',
        display: 'Building & renovation > Tools',
        depth: 2,
        parentSlug: 'building-renovation',
        embedding: [0, 1],
      },
    ]);
    // Overwrite the seeded embedding with NULL to simulate a pre-backfill DB.
    db.prepare('UPDATE trademe_categories SET embedding = NULL').run();
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);

    await expect(resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG)).rejects.toThrow(
      'no embedded categories available'
    );
  });

  // PR #41 review (Data #3, QA #2, expanded): a stale embedding_model tag means the stored
  // vector came from a previous EMBEDDING_MODEL — comparing it against a current-model prompt
  // embedding could silently corrupt ranking (worse, with no error, if dimensions happen to
  // match). Excluding it entirely — same treatment as a null embedding — guarantees the
  // resolver never compares vectors across models, even mid-migration.
  it('excludes a category whose embedding_model does not match the current model, same as a null embedding', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedCategories(db, [
      {
        slug: 'building-renovation/tools',
        display: 'Building & renovation > Tools',
        depth: 2,
        parentSlug: 'building-renovation',
        embedding: [1, 0],
      },
      {
        slug: 'building-renovation/building-supplies/scaffolding-ladders',
        display: 'Building & renovation > Building supplies > Ladders',
        depth: 3,
        parentSlug: 'building-renovation/building-supplies',
        embedding: [0, 1],
        embeddingModel: 'stale-model-v0',
      },
    ]);
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({ categories: [{ slug: 'building-renovation/tools', searchString: null }] })
    );

    const { entries } = await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    expect(entries.map((e) => e.slug)).not.toContain(
      'building-renovation/building-supplies/scaffolding-ladders'
    );
  });

  // PR #41 review (Data #3): a single malformed embedding row must not take down the whole
  // discover request — it should be skipped, same as a null embedding, not thrown.
  it('skips a category with malformed embedding JSON instead of throwing', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedCategories(db, [
      {
        slug: 'building-renovation/tools',
        display: 'Building & renovation > Tools',
        depth: 2,
        parentSlug: 'building-renovation',
        embedding: [1, 0],
      },
    ]);
    db.prepare(
      'INSERT INTO trademe_categories (slug, display, depth, parent_slug, legacy_path, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'building-renovation/building-supplies/scaffolding-ladders',
      'Building & renovation > Building supplies > Ladders',
      3,
      'building-renovation/building-supplies',
      'legacy/scaffolding-ladders',
      'not valid json',
      EMBEDDING_MODEL
    );
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({ categories: [{ slug: 'building-renovation/tools', searchString: null }] })
    );

    const { entries } = await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    expect(entries.map((e) => e.slug)).toContain('building-renovation/tools');
    expect(entries.map((e) => e.slug)).not.toContain(
      'building-renovation/building-supplies/scaffolding-ladders'
    );
  });

  // Backend/QA review of PR #41: embedTextAsync has no retry or fallback (by design —
  // see embeddings.ts), so a Gemini failure must at least surface as a diagnosable error
  // rather than an opaque provider message, consistent with this function's other thrown
  // errors above. discover.ts's Promise.allSettled already keeps this from crashing the
  // whole discover request; this pins the error's shape so it's actionable when it hits
  // logs/warnings.
  it('wraps an embedTextAsync failure in a diagnosable error instead of leaking the raw provider error', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    vi.mocked(embedTextAsync).mockRejectedValue(
      new Error('Gemini embedContent failed [429]: quota exceeded')
    );
    vi.mocked(aiJSON).mockClear();

    await expect(resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG)).rejects.toThrow(
      'discover: category embedding unavailable — Gemini embedContent failed [429]: quota exceeded'
    );
    expect(vi.mocked(aiJSON)).not.toHaveBeenCalled();
  });

  // Backend review of PR #41 (Future Ticket #1): the categories-with-embeddings table only
  // changes via offline backfill scripts, so re-reading and re-parsing the full table on
  // every discover request is wasted work. This pins the in-process cache: the DB is read
  // (and each row's embedding JSON parsed) at most once across repeated calls.
  function countCategoryTableReads(prepareSpy: ReturnType<typeof vi.spyOn>): number {
    return prepareSpy.mock.calls.filter(([sql]: [string]) =>
      sql.includes('FROM trademe_categories')
    ).length;
  }

  it('reads the categories-with-embeddings table from the DB only once across repeated calls', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    vi.mocked(aiJSON).mockResolvedValue(
      aiJsonOk({
        categories: [
          {
            slug: 'building-renovation/building-supplies/scaffolding-ladders',
            searchString: null,
          },
        ],
      })
    );
    const prepareSpy = vi.spyOn(db, 'prepare');

    await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);
    await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    expect(countCategoryTableReads(prepareSpy)).toBe(1);
  });

  it("falls back to the category's own leaf display name when the AI returns a null searchString", async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({
        categories: [{ slug: 'building-renovation/tools', searchString: null }],
      })
    );

    const { entries } = await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    expect(entries).toEqual([{ slug: 'building-renovation/tools', searchString: 'Tools' }]);
  });

  it("falls back to the category's own leaf display name when the AI returns an empty-string searchString", async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    vi.mocked(aiJSON).mockResolvedValueOnce(
      aiJsonOk({
        categories: [{ slug: 'building-renovation/tools', searchString: '   ' }],
      })
    );

    const { entries } = await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    expect(entries).toEqual([{ slug: 'building-renovation/tools', searchString: 'Tools' }]);
  });

  it('invalidateCategoryEmbeddingsCache forces a fresh DB read on the next call', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    vi.mocked(embedTextAsync).mockResolvedValue([1, 0]);
    vi.mocked(aiJSON).mockResolvedValue(
      aiJsonOk({
        categories: [
          {
            slug: 'building-renovation/building-supplies/scaffolding-ladders',
            searchString: null,
          },
        ],
      })
    );
    const prepareSpy = vi.spyOn(db, 'prepare');

    await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);
    invalidateCategoryEmbeddingsCache();
    await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    expect(countCategoryTableReads(prepareSpy)).toBe(2);
  });
});

// ── assertCategoryEmbeddingCoverage ─────────────────────────────────────────

// PR #41 review (Data #2): a partially-completed embedding backfill silently makes some
// categories unreachable via AI category selection, with zero signal anything is degraded.
// Per the user's direction, this is enforced at server boot rather than as a per-request
// warning — the app should refuse to start rather than silently serve degraded discovery.
describe('assertCategoryEmbeddingCoverage', () => {
  it('throws naming the import script when the categories table is empty', () => {
    const db = new Database(':memory:');
    initSchema(db);

    expect(() => assertCategoryEmbeddingCoverage(db)).toThrow(/import-categories\.ts/);
  });

  it('throws naming the backfill script and the missing count when some categories lack a current-model embedding', () => {
    const db = new Database(':memory:');
    initSchema(db);
    seedCategories(db, [
      {
        slug: 'building-renovation/tools',
        display: 'Building & renovation > Tools',
        depth: 2,
        parentSlug: 'building-renovation',
        embedding: [1, 0],
      },
      {
        slug: 'building-renovation/building-supplies',
        display: 'Building & renovation > Building supplies',
        depth: 2,
        parentSlug: 'building-renovation',
        embedding: [0, 1],
        embeddingModel: 'stale-model-v0',
      },
    ]);

    expect(() => assertCategoryEmbeddingCoverage(db)).toThrow(
      /1\/2 categories.*embed-categories\.ts/
    );
  });

  it('does not throw when every category has a current-model embedding', () => {
    const db = new Database(':memory:');
    initSchema(db);
    seedLadderBugFixture(db);

    expect(() => assertCategoryEmbeddingCoverage(db)).not.toThrow();
  });
});
