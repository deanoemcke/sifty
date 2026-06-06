/**
 * Imports TradeMe categories from the CSV into the SQLite cache DB.
 * Run with: npx ts-node scripts/import-categories.ts
 *
 * Clears the trademe_categories table first, then inserts:
 *   - every row from the CSV (leaf and terminal nodes)
 *   - synthesised intermediate rows for every prefix depth >= 2
 *     (e.g. "Computers > Laptops > Laptops > Apple" also produces
 *      "Computers > Laptops" and "Computers > Laptops > Laptops")
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH   = path.resolve(__dirname, '../.cache/cache.db');
const CSV_PATH  = path.resolve(__dirname, '../assets/trademe-categories - Tradevine Categories.csv');

if (!fs.existsSync(CSV_PATH)) {
  console.error(`CSV not found: ${CSV_PATH}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS trademe_categories (
    slug        TEXT PRIMARY KEY,
    display     TEXT NOT NULL,
    depth       INTEGER NOT NULL,
    parent_slug TEXT,
    top2        TEXT NOT NULL
  );
`);

db.prepare('DELETE FROM trademe_categories').run();
console.log('Cleared trademe_categories.');

const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n');

// Build a deduplicated map of slug → row, including synthesised intermediates.
const seen = new Map<string, [string, string, number, string | null, string]>();
let csvRows = 0;

for (const line of lines.slice(1)) {
  const m = line.match(/^\d+,([^,]+),/);
  if (!m) continue;
  const parts = m[1].trim().split(' > ');
  if (parts.length < 2) continue;
  csvRows++;

  const slugParts = parts.map(p => p.toLowerCase());
  const top2 = slugParts.slice(0, 2).join('/');

  for (let d = 2; d <= parts.length; d++) {
    const slug = slugParts.slice(0, d).join('/');
    if (!seen.has(slug)) {
      const display     = parts.slice(0, d).join(' > ');
      const parent_slug = slugParts.slice(0, d - 1).join('/') || null;
      seen.set(slug, [slug, display, d, parent_slug, top2]);
    }
  }
}

const rows = [...seen.values()];
const synthesised = rows.length - csvRows;

const insert = db.prepare(
  'INSERT INTO trademe_categories (slug, display, depth, parent_slug, top2) VALUES (?, ?, ?, ?, ?)'
);
const insertAll = db.transaction(() => {
  for (const r of rows) insert.run(r[0], r[1], r[2], r[3], r[4]);
});
insertAll();

const depth2Count = rows.filter(r => r[2] === 2).length;
console.log(`Inserted ${rows.length} rows (${csvRows} from CSV, ${synthesised} synthesised intermediates)`);
console.log(`  depth=2 categories available for step-1 discovery: ${depth2Count}`);
