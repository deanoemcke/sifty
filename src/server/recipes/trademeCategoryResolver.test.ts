import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
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
import { type CategoryWithEmbeddingRow, initSchema } from '../db';
import { embedTextAsync } from '../embeddings';
import {
  CATEGORY_SYSTEM_PROMPT,
  collapseEntries,
  type DiscoverEntry,
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

function entry(slug: string, searchString: string | null = null): DiscoverEntry {
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
      entry('marketplace/computers/laptops/apple', null),
      entry('marketplace/computers/laptops/dell', null),
      entry('marketplace/computers/laptops/lenovo', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ slug: 'marketplace/computers/laptops', searchString: null });
  });

  it('collapses one sibling group and leaves unrelated entries untouched', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'macbook'),
      entry('marketplace/electronics/cameras/dslr', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
    const slugs = result.map((e) => e.slug);
    expect(slugs).toContain('marketplace/computers/laptops');
    expect(slugs).toContain('marketplace/electronics/cameras/dslr');
  });

  it('does not emit the collapsed parent slug twice when three siblings collapse', () => {
    const input = [
      entry('marketplace/furniture/home/bedroom', null),
      entry('marketplace/furniture/home/living', null),
      entry('marketplace/furniture/home/dining', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('marketplace/furniture/home');
  });

  it('does not collapse siblings when their parent is present in the input', () => {
    const input = [
      entry('marketplace/furniture/home'),
      entry('marketplace/furniture/home/bedroom', null),
      entry('marketplace/furniture/home/living', null),
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
      entry('marketplace/furniture/home/bedroom', null),
      entry('marketplace/furniture/home/living', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
    const slugs = result.map((e) => e.slug);
    expect(slugs).toContain('marketplace/computers/laptops');
    expect(slugs).toContain('marketplace/furniture/home');
    const laptops = result.find((e) => e.slug === 'marketplace/computers/laptops');
    const home = result.find((e) => e.slug === 'marketplace/furniture/home');
    expect(laptops?.searchString).toBe('macbook');
    expect(home?.searchString).toBeNull();
  });
});

// ── rankCategoriesBySimilarity ─────────────────────────────────────────────

function embeddedCategory(
  slug: string,
  display: string,
  embedding: number[] | null
): CategoryWithEmbeddingRow {
  return { slug, display, embedding: embedding === null ? null : JSON.stringify(embedding) };
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
  top2: string;
  embedding: number[];
};

function seedCategories(db: Database.Database, categories: SeedCategory[]): void {
  const insert = db.prepare(
    'INSERT INTO trademe_categories (slug, display, depth, parent_slug, top2, legacy_path, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const category of categories) {
    insert.run(
      category.slug,
      category.display,
      category.depth,
      category.parentSlug,
      category.top2,
      `legacy/${category.slug}`,
      JSON.stringify(category.embedding)
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
      top2: 'building-renovation/tools',
      embedding: [0, 1],
    },
    {
      slug: 'building-renovation/tools/hand-tools',
      display: 'Building & renovation > Tools > Hand tools',
      depth: 3,
      parentSlug: 'building-renovation/tools',
      top2: 'building-renovation/tools',
      embedding: [0, 1],
    },
    {
      slug: 'building-renovation/building-supplies',
      display: 'Building & renovation > Building supplies',
      depth: 2,
      parentSlug: 'building-renovation',
      top2: 'building-renovation/building-supplies',
      embedding: [0.2, 0.8],
    },
    {
      slug: 'building-renovation/building-supplies/scaffolding-ladders',
      display: 'Building & renovation > Building supplies > Scaffolding & ladders',
      depth: 3,
      parentSlug: 'building-renovation/building-supplies',
      top2: 'building-renovation/building-supplies',
      embedding: [0.9, 0.1],
    },
    {
      slug: 'building-renovation/building-supplies/scaffolding-ladders/ladders',
      display: 'Building & renovation > Building supplies > Scaffolding & ladders > Ladders',
      depth: 4,
      parentSlug: 'building-renovation/building-supplies/scaffolding-ladders',
      top2: 'building-renovation/building-supplies',
      embedding: [1, 0],
    },
  ]);
}

function aiJsonOk(value: unknown) {
  return { kind: 'ok' as const, value };
}

describe('resolveDiscoverCategoriesAsync', () => {
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
        top2: 'building-renovation/tools',
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
});
