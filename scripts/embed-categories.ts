/**
 * Backfills the `embedding` column for every TradeMe category row.
 * Run with: npx tsx scripts/embed-categories.ts
 *
 * Must run AFTER scripts/import-categories.ts — that script drops and recreates
 * trademe_categories on every run, wiping any previously computed embeddings.
 *
 * Idempotent: only rows with embedding IS NULL or a stale embedding_model are
 * processed, and each chunk is persisted immediately after it's embedded, so a
 * re-run after a partial failure (network error, rate limit, etc.) resumes
 * without re-spending API calls on already-current-model rows. Tagging each row
 * with the model that produced it means a future EMBEDDING_MODEL_TAG bump is picked
 * up automatically on the next run, instead of silently no-op'ing because every
 * row already has a (stale-model) embedding.
 */

import Database from 'better-sqlite3';
import { DB_PATH } from '../src/server/db';
import {
  EMBEDDING_MODEL_TAG,
  embedTextsBatchAsync,
  floatsToBuffer,
} from '../src/server/embeddings';
import { loadServerEnv } from '../src/server/env';

loadServerEnv();

const CHUNK_SIZE = 100;

type PendingRow = { slug: string; display: string };

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function run(): Promise<void> {
  const db = new Database(DB_PATH);
  const pending = db
    .prepare<
      [string],
      PendingRow
    >('SELECT slug, display FROM trademe_categories WHERE embedding IS NULL OR embedding_model IS NOT ?')
    .all(EMBEDDING_MODEL_TAG);

  if (pending.length === 0) {
    console.log('All categories already have embeddings.');
    return;
  }
  console.log(`${pending.length} categories need embeddings.`);

  const update = db.prepare(
    'UPDATE trademe_categories SET embedding = ?, embedding_model = ? WHERE slug = ?'
  );
  let embeddedCount = 0;

  for (const chunk of chunkItems(pending, CHUNK_SIZE)) {
    const embeddings = await embedTextsBatchAsync(chunk.map((row) => row.display));
    const persistChunk = db.transaction(() => {
      chunk.forEach((row, index) => {
        update.run(floatsToBuffer(embeddings[index]), EMBEDDING_MODEL_TAG, row.slug);
      });
    });
    persistChunk();
    embeddedCount += chunk.length;
    console.log(`Embedded ${embeddedCount}/${pending.length}`);
  }

  console.log('Done.');
}

run();
