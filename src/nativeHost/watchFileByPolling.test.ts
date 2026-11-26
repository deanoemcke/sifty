import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPollingFileWatcher } from './watchFileByPolling';

const POLL_INTERVAL_MS = 20;
const WAIT_LIMIT_MS = 2000;

let temporaryDirectory: string;

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sifty-watch-'));
});

afterEach(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function waitForAsync(isDone: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const timer = setInterval(() => {
      if (isDone()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAtMs > WAIT_LIMIT_MS) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for the file watcher'));
      }
    }, 5);
  });
}

describe('createPollingFileWatcher', () => {
  it('reports an append to an existing file', async () => {
    const filePath = path.join(temporaryDirectory, 'existing.log');
    fs.writeFileSync(filePath, 'one\n');
    let changeCount = 0;
    const stopWatching = createPollingFileWatcher(POLL_INTERVAL_MS)(filePath, () => {
      changeCount += 1;
    });

    fs.appendFileSync(filePath, 'two\n');
    await waitForAsync(() => changeCount > 0);
    stopWatching();
  });

  it('reports a file that did not exist when watching began', async () => {
    const filePath = path.join(temporaryDirectory, 'later.log');
    let changeCount = 0;
    const stopWatching = createPollingFileWatcher(POLL_INTERVAL_MS)(filePath, () => {
      changeCount += 1;
    });

    fs.writeFileSync(filePath, 'created\n');
    await waitForAsync(() => changeCount > 0);
    stopWatching();
  });

  it('reports nothing after it is stopped', async () => {
    const filePath = path.join(temporaryDirectory, 'stopped.log');
    fs.writeFileSync(filePath, 'one\n');
    let changeCount = 0;
    const stopWatching = createPollingFileWatcher(POLL_INTERVAL_MS)(filePath, () => {
      changeCount += 1;
    });
    stopWatching();

    fs.appendFileSync(filePath, 'two\n');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 5));

    expect(changeCount).toBe(0);
  });
});
