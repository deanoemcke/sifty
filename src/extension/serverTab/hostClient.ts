// Typed requests to the native host, with replies checked at the boundary.

import type { RunHistoryEntry } from '../../nativeHost/handleMessage';
import { NATIVE_HOST_NAME } from '../../nativeHost/hostName';
import type { FacebookCookieStatus } from '../../server/facebookCookies';
import type { SchedulerSettings } from '../../server/settings';
import type { ChromeApi } from '../startCookieSync';

// Chrome could not start the host or talk to it: not installed, wrong
// extension ID in the host manifest, or the wrapper script crashed.
export class HostUnreachableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'HostUnreachableError';
  }
}

// The host ran and answered with `{ ok: false }`, or with something that is
// not a valid reply.
export class HostRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'HostRejectedError';
  }
}

export type LogTail = { isLogFilePresent: boolean; logLines: string[] };

export type HostClient = {
  getStatus(): Promise<{ cookies: FacebookCookieStatus; settings: SchedulerSettings }>;
  getRunHistory(): Promise<RunHistoryEntry[]>;
  updateSettings(changes: SchedulerSettings): Promise<SchedulerSettings>;
  tailLog(logName: string, lineCount: number): Promise<LogTail>;
};

type ReplyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ReplyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireField<Value>(
  reply: ReplyRecord,
  fieldName: string,
  isValid: (value: unknown) => value is Value
): Value {
  const value = reply[fieldName];
  if (!isValid(value)) throw new HostRejectedError(`Host reply has no valid "${fieldName}"`);
  return value;
}

const isObject = (value: unknown): value is ReplyRecord => isRecord(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export function createHostClient(chromeApi: Pick<ChromeApi, 'runtime'>): HostClient {
  async function requestAsync(message: ReplyRecord): Promise<ReplyRecord> {
    let reply: unknown;
    try {
      reply = await chromeApi.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);
    } catch (error) {
      throw new HostUnreachableError(error instanceof Error ? error.message : String(error));
    }
    if (!isRecord(reply)) throw new HostRejectedError('Host sent a reply that is not an object');
    if (reply.ok !== true) {
      throw new HostRejectedError(typeof reply.error === 'string' ? reply.error : 'Host error');
    }
    return reply;
  }

  return {
    async getStatus() {
      const reply = await requestAsync({ type: 'getStatus' });
      return {
        cookies: requireField(reply, 'cookies', isObject) as FacebookCookieStatus,
        settings: requireField(reply, 'settings', isObject) as SchedulerSettings,
      };
    },
    async getRunHistory() {
      const reply = await requestAsync({ type: 'getRunHistory' });
      return requireField(reply, 'searches', isArray) as RunHistoryEntry[];
    },
    async updateSettings(changes) {
      const reply = await requestAsync({ type: 'updateSettings', changes });
      return requireField(reply, 'settings', isObject) as SchedulerSettings;
    },
    async tailLog(logName, lineCount) {
      const reply = await requestAsync({ type: 'tailLog', logName, lineCount });
      return {
        isLogFilePresent: requireField(reply, 'isLogFilePresent', isBoolean),
        logLines: requireField(reply, 'logLines', isStringArray),
      };
    },
  };
}
