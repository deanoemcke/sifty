import fs from 'node:fs';
import type { WatchFile } from './logStreams';

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
