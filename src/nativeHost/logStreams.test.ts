import { describe, expect, it } from 'vitest';
import { createLogStreams, type LogStreamEvent, type WatchFile } from './logStreams';
import type { LogTail } from './readLogTail';

const LOG_FILE_PATHS_BY_LOG_NAME = {
  scheduler: '/logs/scheduler.log',
  webapp: '/logs/webapp.log',
};

function makeFakeEnvironment() {
  const tailsByFilePath: Record<string, LogTail | Error> = {
    '/logs/scheduler.log': { isLogFilePresent: true, logLines: ['scheduler line'] },
    '/logs/webapp.log': { isLogFilePresent: false, logLines: [] },
  };
  const readLineCounts: number[] = [];
  const sentEvents: LogStreamEvent[] = [];
  const listenersByFilePath = new Map<string, Set<() => void>>();
  let sendFailure: Error | undefined;

  const watchFile: WatchFile = (filePath, onChange) => {
    const listeners = listenersByFilePath.get(filePath) ?? new Set();
    listeners.add(onChange);
    listenersByFilePath.set(filePath, listeners);
    return () => listeners.delete(onChange);
  };

  const logStreams = createLogStreams({
    logFilePathsByLogName: LOG_FILE_PATHS_BY_LOG_NAME,
    watchFile,
    readLogTail: (filePath, lineCount) => {
      readLineCounts.push(lineCount);
      const tail = tailsByFilePath[filePath];
      if (tail instanceof Error) throw tail;
      return tail;
    },
    sendAsync: async (event) => {
      if (sendFailure) throw sendFailure;
      sentEvents.push(event);
    },
  });

  return {
    logStreams,
    sentEvents,
    readLineCounts,
    tailsByFilePath,
    failSends: (error: Error) => {
      sendFailure = error;
    },
    changeFile: (filePath: string) => {
      for (const listener of listenersByFilePath.get(filePath) ?? []) listener();
    },
    watcherCount: () => [...listenersByFilePath.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

async function settleAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('createLogStreams', () => {
  it('sends the current tail of every log as soon as it is subscribed', async () => {
    const environment = makeFakeEnvironment();

    environment.logStreams.subscribe(200);
    await settleAsync();

    expect(environment.sentEvents).toEqual([
      {
        ok: true,
        event: 'logTail',
        logName: 'scheduler',
        isLogFilePresent: true,
        logLines: ['scheduler line'],
      },
      { ok: true, event: 'logTail', logName: 'webapp', isLogFilePresent: false, logLines: [] },
    ]);
    expect(environment.readLineCounts).toEqual([200, 200]);
  });

  it('sends a fresh tail for only the log whose file changed', async () => {
    const environment = makeFakeEnvironment();
    environment.logStreams.subscribe(200);
    await settleAsync();
    environment.sentEvents.length = 0;

    environment.tailsByFilePath['/logs/webapp.log'] = {
      isLogFilePresent: true,
      logLines: ['server started'],
    };
    environment.changeFile('/logs/webapp.log');
    await settleAsync();

    expect(environment.sentEvents).toEqual([
      {
        ok: true,
        event: 'logTail',
        logName: 'webapp',
        isLogFilePresent: true,
        logLines: ['server started'],
      },
    ]);
  });

  it('stops watching every file and sends nothing more once stopped', async () => {
    const environment = makeFakeEnvironment();
    environment.logStreams.subscribe(200);
    await settleAsync();
    environment.sentEvents.length = 0;

    environment.logStreams.stopAll();
    environment.changeFile('/logs/scheduler.log');
    await settleAsync();

    expect(environment.watcherCount()).toBe(0);
    expect(environment.sentEvents).toEqual([]);
  });

  it('replaces the earlier subscription when subscribed again', async () => {
    const environment = makeFakeEnvironment();
    environment.logStreams.subscribe(200);
    environment.logStreams.subscribe(50);
    await settleAsync();
    environment.readLineCounts.length = 0;
    environment.sentEvents.length = 0;

    environment.changeFile('/logs/scheduler.log');
    await settleAsync();

    expect(environment.watcherCount()).toBe(2);
    expect(environment.sentEvents).toHaveLength(1);
    expect(environment.readLineCounts).toEqual([50]);
  });

  it('reports a log that cannot be read and keeps streaming the others', async () => {
    const environment = makeFakeEnvironment();
    environment.tailsByFilePath['/logs/scheduler.log'] = new Error('EACCES: permission denied');

    environment.logStreams.subscribe(200);
    await settleAsync();

    expect(environment.sentEvents).toEqual([
      {
        ok: false,
        logName: 'scheduler',
        error: 'Could not read the scheduler log: EACCES: permission denied',
      },
      { ok: true, event: 'logTail', logName: 'webapp', isLogFilePresent: false, logLines: [] },
    ]);
    environment.sentEvents.length = 0;

    environment.tailsByFilePath['/logs/scheduler.log'] = {
      isLogFilePresent: true,
      logLines: ['recovered'],
    };
    environment.changeFile('/logs/scheduler.log');
    await settleAsync();

    expect(environment.sentEvents).toHaveLength(1);
  });

  it('stops watching when the connection can no longer be written to', async () => {
    const environment = makeFakeEnvironment();
    environment.logStreams.subscribe(200);
    await settleAsync();

    environment.failSends(new Error('EPIPE'));
    environment.changeFile('/logs/scheduler.log');
    await settleAsync();

    expect(environment.watcherCount()).toBe(0);
  });
});
