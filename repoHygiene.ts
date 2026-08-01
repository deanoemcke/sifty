import fs from 'node:fs';

/**
 * Returns the subset of `filePaths` whose contents contain a literal NUL byte
 * (`\x00`). Nothing in this repo's toolchain — Biome, `tsc`, or the test suite —
 * treats source files as anything but valid text, so an accidentally embedded
 * NUL byte silently corrupts the file for `git diff`/`git grep`/GitHub's diff
 * view without breaking type-checking or runtime behaviour. See
 * `repoHygiene.test.ts` for the guard that runs this over tracked source files.
 */
export function findFilesContainingNulBytes(filePaths: string[]): string[] {
  return filePaths.filter((filePath) => fs.readFileSync(filePath).includes(0));
}
