/**
 * Imports TradeMe categories from the JSON into the SQLite cache DB.
 * Run with: npx ts-node scripts/import-categories.ts
 *
 * Slugs are derived from the Name field (not Path) because the TradeMe API/JSON
 * Path field has inconsistent slugification (e.g. "MercedesBenz" vs "mercedes-benz").
 * Top-level "Trade Me X" categories strip the "Trade Me " prefix (e.g. → "motors").
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH   = path.resolve(__dirname, '../.cache/cache.db');
const JSON_PATH = path.resolve(__dirname, '../assets/trademe-categories.json');

if (!fs.existsSync(JSON_PATH)) {
  console.error(`JSON not found: ${JSON_PATH}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

// Dropped and recreated on every import (not IF NOT EXISTS): this table is a full,
// disposable derivation of the JSON asset, so a schema change here doesn't need a
// migration path — just re-run this script.
db.exec(`
  DROP TABLE IF EXISTS trademe_categories;
  CREATE TABLE trademe_categories (
    slug        TEXT PRIMARY KEY,
    display     TEXT NOT NULL,
    depth       INTEGER NOT NULL,
    parent_slug TEXT,
    top2        TEXT NOT NULL,
    legacy_path TEXT NOT NULL
  );
`);

console.log('Cleared trademe_categories.');

interface Category {
  Name: string;
  Number: string;
  Path: string;
  Subcategories?: Category[];
}

function nameToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function topLevelSlug(name: string): string {
  // "Trade Me Motors" → "motors", "Trade Me Property" → "property"
  if (name.startsWith('Trade Me ')) return name.slice(9).toLowerCase();
  return nameToSlug(name);
}

const rows: [string, string, number, string | null, string, string][] = [];
const seen = new Set<string>();

function walk(node: Category, parentSlugParts: string[], parentDisplayParts: string[], depth: number): void {
  const slugPart = depth === 1 ? topLevelSlug(node.Name) : nameToSlug(node.Name);
  const slugParts   = [...parentSlugParts, slugPart];
  const displayParts = [...parentDisplayParts, node.Name];

  const slug        = slugParts.join('/');
  const display     = displayParts.join(' > ');
  const parent_slug = parentSlugParts.length > 0 ? parentSlugParts.join('/') : null;
  const top2        = slugParts.slice(0, 2).join('/');

  if (depth >= 2 && !seen.has(slug)) {
    seen.add(slug);
    rows.push([slug, display, depth, parent_slug, top2, node.Number]);
  }

  for (const sub of node.Subcategories ?? []) {
    walk(sub, slugParts, displayParts, depth + 1);
  }
}

const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
for (const top of data.Subcategories ?? []) {
  walk(top, [], [], 1);
}

const insert = db.prepare(
  'INSERT INTO trademe_categories (slug, display, depth, parent_slug, top2, legacy_path) VALUES (?, ?, ?, ?, ?, ?)'
);
const insertAll = db.transaction(() => {
  for (const r of rows) insert.run(r[0], r[1], r[2], r[3], r[4], r[5]);
});
insertAll();

const depth2Count = rows.filter(r => r[2] === 2).length;
console.log(`Inserted ${rows.length} rows total`);
console.log(`  depth=2 categories available for step-1 discovery: ${depth2Count}`);

// Spot-check
const check = db.prepare('SELECT slug, display FROM trademe_categories WHERE slug LIKE ?');
console.log('\nSpot-check (mercedes):');
for (const row of check.all('%mercedes%') as any[]) {
  console.log(' ', row.slug, '|', row.display);
}
console.log('Spot-check (motors/cars):');
for (const row of check.all('motors/cars%') as any[]) {
  if ((row.slug as string).split('/').length <= 3) console.log(' ', row.slug, '|', row.display);
}
