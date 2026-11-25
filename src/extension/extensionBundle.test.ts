import path from 'node:path';
import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const SERVER_ONLY_MARKERS = ['better-sqlite3', 'initSchema'];

async function buildExtensionChunkCodesAsync(): Promise<string[]> {
  const output = await build({
    configFile: path.resolve(__dirname, '../../vite.extension.config.ts'),
    logLevel: 'silent',
    build: { write: false },
  });
  const outputs = (Array.isArray(output) ? output : [output]) as Rollup.RollupOutput[];
  return outputs
    .flatMap((rollupOutput) => rollupOutput.output)
    .flatMap((item) => (item.type === 'chunk' ? [item.code] : []));
}

describe('extension bundle', () => {
  it('contains no server database code, which cannot run in the browser', async () => {
    const chunkCodes = await buildExtensionChunkCodesAsync();

    expect(chunkCodes.length).toBeGreaterThan(0);
    for (const marker of SERVER_ONLY_MARKERS) {
      expect(chunkCodes.filter((code) => code.includes(marker))).toEqual([]);
    }
  }, 30_000);
});
