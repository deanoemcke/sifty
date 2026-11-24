import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../server/db';
import type { NativeHostDependencies } from './handleMessage';
import {
  createNativeMessageDecoder,
  encodeNativeMessage,
  MAX_INCOMING_MESSAGE_BYTES,
} from './nativeMessaging';
import { runNativeHostAsync } from './runNativeHost';

function makeDependencies(): NativeHostDependencies {
  const database = new Database(':memory:');
  initSchema(database);
  return {
    database,
    logFilePathsByLogName: {},
    services: {
      definitionsByServiceName: {},
      userId: 501,
      runLaunchctlAsync: async () => ({
        exitCode: 1,
        output: 'launchctl is not available in this test',
      }),
      doesFileExist: () => true,
    },
  };
}

// Feeds the given chunks to the host as its stdin, closes stdin, and returns
// how the loop ended along with every reply it wrote to stdout.
async function runHostWithChunks(chunks: Buffer[], dependencies = makeDependencies()) {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => outputChunks.push(chunk));

  const outcomePromise = runNativeHostAsync(input, output, dependencies);
  for (const chunk of chunks) input.write(chunk);
  input.end();
  const outcome = await outcomePromise;

  const replies = createNativeMessageDecoder().push(Buffer.concat(outputChunks));
  return { outcome, replies };
}

describe('runNativeHostAsync', () => {
  it('writes one framed reply for one request, then finishes when input closes', async () => {
    const { outcome, replies } = await runHostWithChunks([
      encodeNativeMessage({ type: 'getStatus' }),
    ]);

    expect(outcome).toBe('input-closed');
    expect(replies).toEqual([
      {
        ok: true,
        cookies: { isSynced: false },
        settings: { targetIntervalMinutes: 240, maxSearchesPerTick: 5 },
      },
    ]);
  });

  it('answers two requests that arrive in one chunk, in order', async () => {
    const { replies } = await runHostWithChunks([
      Buffer.concat([
        encodeNativeMessage({ type: 'getRunHistory' }),
        encodeNativeMessage({ type: 'nonsense' }),
      ]),
    ]);

    expect(replies).toEqual([
      { ok: true, searches: [] },
      { ok: false, error: 'Unknown request type: nonsense' },
    ]);
  });

  it('answers a request that arrives split across chunks', async () => {
    const encoded = encodeNativeMessage({ type: 'getRunHistory' });

    const { replies } = await runHostWithChunks([encoded.subarray(0, 3), encoded.subarray(3)]);

    expect(replies).toEqual([{ ok: true, searches: [] }]);
  });

  it('replies once with an error and stops when a message declares an oversized length', async () => {
    const oversizedPrefix = Buffer.alloc(4);
    oversizedPrefix.writeUInt32LE(MAX_INCOMING_MESSAGE_BYTES + 1, 0);

    const { outcome, replies } = await runHostWithChunks([
      encodeNativeMessage({ type: 'getRunHistory' }),
      oversizedPrefix,
      encodeNativeMessage({ type: 'getRunHistory' }),
    ]);

    expect(outcome).toBe('protocol-error');
    expect(replies).toEqual([
      { ok: true, searches: [] },
      { ok: false, error: expect.stringContaining('too large') },
    ]);
  });

  it('replies once with an error and stops when a message body is not valid JSON', async () => {
    const notJson = Buffer.from('{oops', 'utf8');
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(notJson.length, 0);

    const { outcome, replies } = await runHostWithChunks([Buffer.concat([lengthPrefix, notJson])]);

    expect(outcome).toBe('protocol-error');
    expect(replies).toEqual([{ ok: false, error: expect.stringContaining('not valid JSON') }]);
  });

  it('replies with an error instead of failing silently when a reply is too large for Chrome', async () => {
    const dependencies = makeDependencies();
    const insertSearch = dependencies.database.prepare(
      `INSERT INTO saved_searches
         (id, name, urls, created_at, should_alert_on_new_listings, last_run_at, last_run_detail)
       VALUES (?, ?, '[]', 1, 1, 1, ?)`
    );
    dependencies.database.transaction(() => {
      for (let index = 0; index < 3000; index++) {
        insertSearch.run(`search-${index}`, `Search ${index}`, 'scrape:'.padEnd(500, 'x'));
      }
    })();

    const { outcome, replies } = await runHostWithChunks(
      [encodeNativeMessage({ type: 'getRunHistory' })],
      dependencies
    );

    expect(outcome).toBe('input-closed');
    expect(replies).toEqual([{ ok: false, error: expect.stringContaining('too large') }]);
  });
});
