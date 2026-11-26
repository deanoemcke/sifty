import fs from 'node:fs';
import type { WatchFile } from './logStreams';

// Stat polling rather than fs.watch: it works for a file that does not exist yet and
// survives the file being replaced, which log rotation and launchd can both do.
// The baseline is taken synchronously so a write straight after watching starts is never missed.
export const LOG_POLL_INTERVAL_MS = 250;

function readFileSignature(filePath: string): string {
  try {
    const { ino, size, mtimeMs } = fs.statSync(filePath);
    return `${ino}:${size}:${mtimeMs}`;
  } catch (error) {
    return `unreadable:${(error as NodeJS.ErrnoException).code}`;
  }
}

export function createPollingFileWatcher(pollIntervalMs: number): WatchFile {
  return (filePath, onChange) => {
    let lastSignature = readFileSignature(filePath);
    const timer = setInterval(() => {
      const signature = readFileSignature(filePath);
      if (signature === lastSignature) return;
      lastSignature = signature;
      onChange();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  };
}
