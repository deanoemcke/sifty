import { describeError } from './describeError';
import type { LogTail } from './readLogTail';

export type LogStreamEvent =
  | { ok: true; event: 'logTail'; logName: string; isLogFilePresent: boolean; logLines: string[] }
  | { ok: false; error: string };

export type StopWatching = () => void;
export type WatchFile = (filePath: string, onChange: () => void) => StopWatching;

export type LogStreams = {
  subscribe(lineCount: number): void;
  stopAll(): void;
};

export type LogStreamsOptions = {
  logFilePathsByLogName: Record<string, string>;
  watchFile: WatchFile;
  readLogTail: (logFilePath: string, lineCount: number) => LogTail;
  sendAsync: (event: LogStreamEvent) => Promise<void>;
};

export function createLogStreams(options: LogStreamsOptions): LogStreams {
  const { logFilePathsByLogName, watchFile, readLogTail, sendAsync } = options;
  let stopWatchingCallbacks: StopWatching[] = [];

  function stopAll(): void {
    for (const stopWatching of stopWatchingCallbacks) stopWatching();
    stopWatchingCallbacks = [];
  }

  function sendLogTail(logName: string, logFilePath: string, lineCount: number): void {
    let event: LogStreamEvent;
    try {
      event = { ok: true, event: 'logTail', logName, ...readLogTail(logFilePath, lineCount) };
    } catch (error) {
      event = { ok: false, error: `Could not read the ${logName} log: ${describeError(error)}` };
    }
    sendAsync(event).catch((error) => {
      console.error(`[native-host] log stream stopped: ${describeError(error)}`);
      stopAll();
    });
  }

  function subscribe(lineCount: number): void {
    stopAll();
    for (const [logName, logFilePath] of Object.entries(logFilePathsByLogName)) {
      const sendCurrentLogTail = () => sendLogTail(logName, logFilePath, lineCount);
      stopWatchingCallbacks.push(watchFile(logFilePath, sendCurrentLogTail));
      sendCurrentLogTail();
    }
  }

  return { subscribe, stopAll };
}
