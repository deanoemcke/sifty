import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findFilesContainingNulBytes } from './repoHygiene';

describe('findFilesContainingNulBytes', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  it('flags a file whose contents contain an embedded NUL byte', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sifty-nul-byte-test-'));
    const corruptedFilePath = path.join(tmpDir, 'corrupted.ts');
    fs.writeFileSync(corruptedFilePath, Buffer.from('const key = kind\0message;'));

    expect(findFilesContainingNulBytes([corruptedFilePath])).toEqual([corruptedFilePath]);
  });

  it('does not flag an ordinary text file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sifty-nul-byte-test-'));
    const cleanFilePath = path.join(tmpDir, 'clean.ts');
    fs.writeFileSync(cleanFilePath, 'const key = kind + ":" + message;');

    expect(findFilesContainingNulBytes([cleanFilePath])).toEqual([]);
  });
});

describe('tracked TypeScript source files', () => {
  it('contain no embedded NUL bytes', () => {
    const repoRoot = __dirname;
    const trackedRelativePaths = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    const trackedAbsolutePaths = trackedRelativePaths.map((relativePath) =>
      path.join(repoRoot, relativePath)
    );

    expect(findFilesContainingNulBytes(trackedAbsolutePaths)).toEqual([]);
  });
});
