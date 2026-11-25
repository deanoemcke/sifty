import fs from 'node:fs';

// Written to a temporary file and renamed, so a reader (launchd, Chrome) never sees a half-written file.
export function writeFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, filePath);
}
