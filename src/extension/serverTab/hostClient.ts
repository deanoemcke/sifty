import type { ServiceAction } from '../../nativeHost/controlService';
import { describeError } from '../../nativeHost/describeError';
import type { InstalledServiceState, RunHistoryEntry } from '../../nativeHost/handleMessage';
import { NATIVE_HOST_NAME } from '../../nativeHost/hostName';
import { isRecord, type UnknownRecord } from '../../nativeHost/isRecord';
import { buildNativeHostRequest, type NativeHostRequest } from '../../nativeHost/protocol';
import type { LogTail } from '../../nativeHost/readLogTail';
import type { FacebookCookieStatus } from '../../server/facebookCookies';
import {
  SCHEDULER_SETTING_DEFINITIONS,
  type SchedulerSettings,
} from '../../server/schedulerSettingDefinitions';
import type { ChromeApi } from '../startCookieSync';

export class HostUnreachableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'HostUnreachableError';
  }
}

export class HostRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'HostRejectedError';
  }
}

export type { LogTail };

export type HostStatus = { cookies: FacebookCookieStatus; settings: SchedulerSettings };

export type PanelResult<Value> =
  | { status: 'fulfilled'; value: Value }
  | { status: 'rejected'; reason: Error };

export type ServerTabPanels = {
  services: PanelResult<Record<string, InstalledServiceState>>;
  status: PanelResult<HostStatus>;
  runHistory: PanelResult<RunHistoryEntry[]>;
  logTail: PanelResult<LogTail>;
};

export type HostClient = {
  getPanels(logName: string, lineCount: number): Promise<ServerTabPanels>;
  updateSettings(changes: SchedulerSettings): Promise<SchedulerSettings>;
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

function requireOkReply(reply: unknown): UnknownRecord {
  if (!isRecord(reply)) throw new HostRejectedError('Host sent a reply that is not an object');
  if (reply.ok !== true) {
    throw new HostRejectedError(typeof reply.error === 'string' ? reply.error : 'Host error');
  }
  return reply;
}

function parseServicesReply(reply: UnknownRecord): Record<string, InstalledServiceState> {
  return requireField(reply, 'servicesByName', isInstalledServiceStatesByName);
}

function parseStatusReply(reply: UnknownRecord): HostStatus {
  return {
    cookies: requireField(reply, 'cookies', isFacebookCookieStatus),
    settings: requireField(reply, 'settings', isSchedulerSettings),
  };
}

function parseRunHistoryReply(reply: UnknownRecord): RunHistoryEntry[] {
  return requireField(reply, 'searches', isRunHistoryEntries);
}

function parseLogTailReply(reply: UnknownRecord): LogTail {
  return {
    isLogFilePresent: requireField(reply, 'isLogFilePresent', isBoolean),
    logLines: requireField(reply, 'logLines', isStringArray),
  };
}

function settleSubReply<Value>(
  subReply: unknown,
  parseReply: (reply: UnknownRecord) => Value
): PanelResult<Value> {
  try {
    return { status: 'fulfilled', value: parseReply(requireOkReply(subReply)) };
  } catch (error) {
    return { status: 'rejected', reason: error as Error };
  }
}

function rejectEveryPanel(reason: Error): ServerTabPanels {
  const rejected = { status: 'rejected', reason } as const;
  return { services: rejected, status: rejected, runHistory: rejected, logTail: rejected };
}

function requireReplyPerRequest(batchReply: UnknownRecord, requestCount: number): unknown[] {
  const replies = requireField(batchReply, 'replies', Array.isArray);
  if (replies.length !== requestCount) {
    throw new HostRejectedError(`Host sent ${replies.length} replies for ${requestCount} requests`);
  }
  return replies;
}

export function createHostClient(chromeApi: Pick<ChromeApi, 'runtime'>): HostClient {
  async function requestAsync(message: NativeHostRequest): Promise<UnknownRecord> {
    let reply: unknown;
    try {
      reply = await chromeApi.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);
    } catch (error) {
      throw new HostUnreachableError(describeError(error));
    }
    return requireOkReply(reply);
  }

  return {
    async getPanels(logName, lineCount) {
      const requests = [
        buildNativeHostRequest('getServices', {}),
        buildNativeHostRequest('getStatus', {}),
        buildNativeHostRequest('getRunHistory', {}),
        buildNativeHostRequest('tailLog', { logName, lineCount }),
      ];
      let subReplies: unknown[];
      try {
        const batchReply = await requestAsync(buildNativeHostRequest('batch', { requests }));
        subReplies = requireReplyPerRequest(batchReply, requests.length);
      } catch (error) {
        return rejectEveryPanel(error as Error);
      }
      const [servicesReply, statusReply, runHistoryReply, logTailReply] = subReplies;
      return {
        services: settleSubReply(servicesReply, parseServicesReply),
        status: settleSubReply(statusReply, parseStatusReply),
        runHistory: settleSubReply(runHistoryReply, parseRunHistoryReply),
        logTail: settleSubReply(logTailReply, parseLogTailReply),
      };
    },
    async updateSettings(changes) {
      const reply = await requestAsync(buildNativeHostRequest('updateSettings', { changes }));
      return requireField(reply, 'settings', isSchedulerSettings);
    },
    async controlService(serviceName, action) {
      await requestAsync(buildNativeHostRequest('controlService', { serviceName, action }));
    },
  };
}
