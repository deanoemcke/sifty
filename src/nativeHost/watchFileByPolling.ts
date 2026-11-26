import fs from 'node:fs';
import type { WatchFile } from './logStreams';

// Stat polling rather than fs.watch: it works for a file that does not exist yet and
// survives the file being replaced, which log rotation and launchd can both do.
export const LOG_POLL_INTERVAL_MS = 250;

export function createPollingFileWatcher(pollIntervalMs: number): WatchFile {
  return (filePath, onChange) => {
    const onStatChange = () => onChange();
    fs.watchFile(filePath, { interval: pollIntervalMs }, onStatChange);
    return () => fs.unwatchFile(filePath, onStatChange);
  };
}
