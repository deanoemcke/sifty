// Typed requests to the native host, with replies checked at the boundary.

import type { ServiceAction } from '../../nativeHost/controlService';
import { describeError } from '../../nativeHost/describeError';
import type { InstalledServiceState, RunHistoryEntry } from '../../nativeHost/handleMessage';
import { NATIVE_HOST_NAME } from '../../nativeHost/hostName';
import { isRecord, type UnknownRecord } from '../../nativeHost/isRecord';
import type { LogTail } from '../../nativeHost/readLogTail';
import type { FacebookCookieStatus } from '../../server/facebookCookies';
import {
  SCHEDULER_SETTING_DEFINITIONS,
  type SchedulerSettings,
} from '../../server/schedulerSettingDefinitions';
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

export type { LogTail };

export type HostClient = {
  getStatus(): Promise<{ cookies: FacebookCookieStatus; settings: SchedulerSettings }>;
  getRunHistory(): Promise<RunHistoryEntry[]>;
  updateSettings(changes: SchedulerSettings): Promise<SchedulerSettings>;
  tailLog(logName: string, lineCount: number): Promise<LogTail>;
  getServices(): Promise<Record<string, InstalledServiceState>>;
  controlService(serviceName: string, action: ServiceAction): Promise<void>;
};

function requireField<Value>(
  reply: UnknownRecord,
  fieldName: string,
  isValid: (value: unknown) => value is Value
): Value {
  const value = reply[fieldName];
  if (!isValid(value)) throw new HostRejectedError(`Host reply has no valid "${fieldName}"`);
  return value;
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isNullableNumber = (value: unknown): value is number | null =>
  value === null || isNumber(value);
const isNullableBoolean = (value: unknown): value is boolean | null =>
  value === null || isBoolean(value);

function isFacebookCookieStatus(value: unknown): value is FacebookCookieStatus {
  if (!isRecord(value) || !isBoolean(value.isSynced)) return false;
  if (!value.isSynced) return true;
  if (!isNumber(value.syncedAtMs) || !isBoolean(value.isLoginUsable)) return false;
  return value.isLoginUsable
    ? isNumber(value.cookieCount) && isNullableNumber(value.loginExpiryMs)
    : typeof value.unusableReason === 'string';
}

function isSchedulerSettings(value: unknown): value is SchedulerSettings {
  return (
    isRecord(value) &&
    Object.keys(SCHEDULER_SETTING_DEFINITIONS).every((settingName) => isNumber(value[settingName]))
  );
}

function isRunHistoryEntry(value: unknown): value is RunHistoryEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isNullableNumber(value.lastRunAtMs) &&
    isNullableBoolean(value.lastRunSucceeded) &&
    isStringArray(value.lastRunDetailLines) &&
    isNullableNumber(value.nextDueAtMs)
  );
}

const isRunHistoryEntries = (value: unknown): value is RunHistoryEntry[] =>
  Array.isArray(value) && value.every(isRunHistoryEntry);

function isInstalledServiceState(value: unknown): value is InstalledServiceState {
  return (
    isRecord(value) &&
    isBoolean(value.isLoaded) &&
    isBoolean(value.isRunning) &&
    isBoolean(value.isEnabled) &&
    isNullableNumber(value.pid) &&
    isBoolean(value.isInstalled) &&
    isBoolean(value.isIntervalJob)
  );
}

const isInstalledServiceStatesByName = (
  value: unknown
): value is Record<string, InstalledServiceState> =>
  isRecord(value) && Object.values(value).every(isInstalledServiceState);

export function createHostClient(chromeApi: Pick<ChromeApi, 'runtime'>): HostClient {
  async function requestAsync(message: UnknownRecord): Promise<UnknownRecord> {
    let reply: unknown;
    try {
      reply = await chromeApi.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);
    } catch (error) {
      throw new HostUnreachableError(describeError(error));
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
        cookies: requireField(reply, 'cookies', isFacebookCookieStatus),
        settings: requireField(reply, 'settings', isSchedulerSettings),
      };
    },
    async getRunHistory() {
      const reply = await requestAsync({ type: 'getRunHistory' });
      return requireField(reply, 'searches', isRunHistoryEntries);
    },
    async updateSettings(changes) {
      const reply = await requestAsync({ type: 'updateSettings', changes });
      return requireField(reply, 'settings', isSchedulerSettings);
    },
    async getServices() {
      const reply = await requestAsync({ type: 'getServices' });
      return requireField(reply, 'servicesByName', isInstalledServiceStatesByName);
    },
    async controlService(serviceName, action) {
      await requestAsync({ type: 'controlService', serviceName, action });
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
