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

import { aiJSON } from '../ai';
import { initSchema } from '../db';
import {
  collapseEntries,
  type DiscoverEntry,
  extractSearchKeywords,
  resolveDiscoverCategoriesAsync,
  STEP2_SYSTEM_PROMPT,
} from './trademeCategoryResolver';

describe('STEP2_SYSTEM_PROMPT', () => {
  it('contains the required JSON schema keywords for the AI response contract', () => {
    expect(STEP2_SYSTEM_PROMPT).toContain('"categories"');
    expect(STEP2_SYSTEM_PROMPT).toContain('"slug"');
    expect(STEP2_SYSTEM_PROMPT).toContain('"searchString"');
  });

  it('instructs the AI to return JSON', () => {
    expect(STEP2_SYSTEM_PROMPT).toContain('Return JSON');
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

// ── extractSearchKeywords ──────────────────────────────────────────────────

describe('extractSearchKeywords', () => {
  it('extracts a single word', () => {
    expect(extractSearchKeywords('ladder')).toEqual(['ladder']);
  });

  it('drops words shorter than 4 characters', () => {
    expect(extractSearchKeywords('I want a ladder')).toEqual(['want', 'ladder']);
  });

  it('lowercases words', () => {
    expect(extractSearchKeywords('LADDER')).toEqual(['ladder']);
  });

  it('de-duplicates repeated words', () => {
    expect(extractSearchKeywords('ladder ladder')).toEqual(['ladder']);
  });

  it('ignores punctuation and digits', () => {
    expect(extractSearchKeywords('macbook-laptop (2021)!')).toEqual(['macbook', 'laptop']);
  });

  it('caps the number of keywords returned', () => {
    const words = ['able', 'baker', 'coder', 'delta', 'eagle', 'fable', 'gable', 'haste', 'igloo'];
    expect(extractSearchKeywords(words.join(' '))).toEqual(words.slice(0, 8));
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
};

function seedCategories(db: Database.Database, categories: SeedCategory[]): void {
  const insert = db.prepare(
    'INSERT INTO trademe_categories (slug, display, depth, parent_slug, top2, legacy_path) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const category of categories) {
    insert.run(
      category.slug,
      category.display,
      category.depth,
      category.parentSlug,
      category.top2,
      `legacy/${category.slug}`
    );
  }
}

// Reproduces the reported bug: step 1 (mocked below) picks the plausible-but-wrong
// "Tools" sibling for the prompt "ladder", so the correct "Ladders" leaf lives under
// a completely different branch ("Building supplies") that step 1 never selected.
function seedLadderBugFixture(db: Database.Database): void {
  seedCategories(db, [
    {
      slug: 'building-renovation/tools',
      display: 'Building & renovation > Tools',
      depth: 2,
      parentSlug: 'building-renovation',
      top2: 'building-renovation/tools',
    },
    {
      slug: 'building-renovation/tools/hand-tools',
      display: 'Building & renovation > Tools > Hand tools',
      depth: 3,
      parentSlug: 'building-renovation/tools',
      top2: 'building-renovation/tools',
    },
    {
      slug: 'building-renovation/building-supplies',
      display: 'Building & renovation > Building supplies',
      depth: 2,
      parentSlug: 'building-renovation',
      top2: 'building-renovation/building-supplies',
    },
    {
      slug: 'building-renovation/building-supplies/scaffolding-ladders',
      display: 'Building & renovation > Building supplies > Scaffolding & ladders',
      depth: 3,
      parentSlug: 'building-renovation/building-supplies',
      top2: 'building-renovation/building-supplies',
    },
    {
      slug: 'building-renovation/building-supplies/scaffolding-ladders/ladders',
      display: 'Building & renovation > Building supplies > Scaffolding & ladders > Ladders',
      depth: 4,
      parentSlug: 'building-renovation/building-supplies/scaffolding-ladders',
      top2: 'building-renovation/building-supplies',
    },
  ]);
}

function mockAiJsonForLadderBugFixture(searchQuery: string | null = null): void {
  vi.mocked(aiJSON).mockImplementation(async (_config, label) => {
    if (label === 'step1') {
      return {
        kind: 'ok',
        value: {
          categories: ['Building & renovation > Tools'],
          searchLabel: 'ladder',
          searchQuery,
        },
      };
    }
    if (label === 'step2:building-renovation/tools') {
      return {
        kind: 'ok',
        value: {
          categories: [{ slug: 'building-renovation/tools/hand-tools', searchString: null }],
        },
      };
    }
    throw new Error(`unexpected aiJSON label in test: ${label}`);
  });
}

describe('resolveDiscoverCategoriesAsync', () => {
  it('finds the ladders branch via keyword match even when step 1 picks the wrong broad category', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    mockAiJsonForLadderBugFixture();

    const { entries } = await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    // The deeper "Ladders" leaf and its "Scaffolding & ladders" parent both match the
    // keyword; collapseEntries' existing parent-wins rule keeps the shallower one.
    expect(entries.map((e) => e.slug)).toContain(
      'building-renovation/building-supplies/scaffolding-ladders'
    );
  });

  it('adds the keyword-matched branch directly instead of routing it through step 2', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    mockAiJsonForLadderBugFixture();

    const { entries } = await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    const calledLabels = vi.mocked(aiJSON).mock.calls.map((call) => call[1]);
    expect(calledLabels).not.toContain('step2:building-renovation/building-supplies');
    expect(entries.map((e) => e.slug)).toContain(
      'building-renovation/building-supplies/scaffolding-ladders'
    );
  });

  it("uses step 1's searchQuery as the searchString for keyword-matched entries", async () => {
    const db = new Database(':memory:');
    initSchema(db);
    _testDb = db;
    seedLadderBugFixture(db);
    mockAiJsonForLadderBugFixture('extension ladder');

    const { entries } = await resolveDiscoverCategoriesAsync('ladder', () => MOCK_AI_CONFIG);

    const keywordMatchedEntry = entries.find(
      (e) => e.slug === 'building-renovation/building-supplies/scaffolding-ladders'
    );
    expect(keywordMatchedEntry?.searchString).toBe('extension ladder');
  });
});
