import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomically } from './writeFileAtomically';

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sifty-atomic-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('writeFileAtomically', () => {
  it('writes the contents to a new file', () => {
    const filePath = path.join(makeTemporaryDirectory(), 'service.plist');

    writeFileAtomically(filePath, 'first');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('first');
  });

  it('replaces an existing file and leaves no temporary file behind', () => {
    const directory = makeTemporaryDirectory();
    const filePath = path.join(directory, 'service.plist');
    fs.writeFileSync(filePath, 'old');

    writeFileAtomically(filePath, 'new');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('new');
    expect(fs.readdirSync(directory)).toEqual(['service.plist']);
  });

  it('keeps the existing file when the write cannot complete', () => {
    const directory = makeTemporaryDirectory();
    const filePath = path.join(directory, 'service.plist');
    fs.writeFileSync(filePath, 'old');
    fs.mkdirSync(`${filePath}.tmp`);

    expect(() => writeFileAtomically(filePath, 'new')).toThrow();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('old');
  });
});
