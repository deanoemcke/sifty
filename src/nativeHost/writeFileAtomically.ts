import fs from 'node:fs';

export function writeFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, filePath);
}
