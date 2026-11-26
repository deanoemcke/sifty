import type Database from 'better-sqlite3';
import { stmtListSavedSearches } from '../server/db';
import {
  type FacebookCookieStatus,
  getFacebookCookieStatus,
  saveFacebookCookies,
} from '../server/facebookCookies';
import type { SchedulerSettings } from '../server/schedulerSettingDefinitions';
import { getSchedulerSettings, updateSchedulerSettings } from '../server/settings';
import {
  controlServiceAsync,
  getServiceStateAsync,
  type RunLaunchctl,
  SERVICE_ACTIONS,
  type ServiceAction,
  type ServiceDefinition,
} from './controlService';
import { describeError } from './describeError';
import { isRecord } from './isRecord';
import type { LogStreams } from './logStreams';
import {
  isNativeHostRequestType,
  isReadOnlyRequestType,
  MAX_BATCH_REQUEST_COUNT,
  type NativeHostRequestByType,
  type NativeHostRequestType,
  READ_ONLY_REQUEST_TYPES,
} from './protocol';
import { describeHowToInstallService } from './serviceDefinitions';
import type { ServiceState } from './serviceState';

const MAX_LOG_LINE_COUNT = 500;

export type InstalledServiceState = ServiceState & {
  isInstalled: boolean;
  isIntervalJob: boolean;
};

export type NativeHostServices = {
  definitionsByServiceName: Record<string, ServiceDefinition>;
  userId: number;
  runLaunchctlAsync: RunLaunchctl;
  doesFileExist: (filePath: string) => boolean;
};

export type NativeHostDependencies = {
  getDatabase: () => Database.Database;
  logStreams: LogStreams;
  services: NativeHostServices;
};

export type RunHistoryEntry = {
  id: string;
  name: string;
  lastRunAtMs: number | null;
  lastRunSucceeded: boolean | null;
  lastRunDetailLines: string[];
  nextDueAtMs: number | null;
};

type UnvalidatedRequest<Type extends NativeHostRequestType> = {
  readonly [Field in keyof NativeHostRequestByType[Type]]?: unknown;
};

export type NativeHostReply =
  | { ok: false; error: string }
  | { ok: true; cookies: FacebookCookieStatus; settings: SchedulerSettings }
  | { ok: true; cookies: FacebookCookieStatus }
  | { ok: true; settings: SchedulerSettings }
  | { ok: true; searches: RunHistoryEntry[] }
  | { ok: true; isLogFilePresent: boolean; logLines: string[] }
  | { ok: true; isSubscribed: true }
  | { ok: true; servicesByName: Record<string, InstalledServiceState> }
  | { ok: true; serviceName: string; state: ServiceState }
  | { ok: true; replies: NativeHostReply[] };

function getStatus(dependencies: NativeHostDependencies): NativeHostReply {
  return {
    ok: true,
    cookies: getFacebookCookieStatus(dependencies.getDatabase()),
    settings: getSchedulerSettings(dependencies.getDatabase()),
  };
}

function syncCookies(
  message: UnvalidatedRequest<'syncCookies'>,
  dependencies: NativeHostDependencies
): NativeHostReply {
  if (typeof message.cookiesJson !== 'string') {
    return { ok: false, error: 'syncCookies requires cookiesJson to be a string' };
  }
  saveFacebookCookies(dependencies.getDatabase(), message.cookiesJson);
  return { ok: true, cookies: getFacebookCookieStatus(dependencies.getDatabase()) };
}

function updateSettings(
  message: UnvalidatedRequest<'updateSettings'>,
  dependencies: NativeHostDependencies
): NativeHostReply {
  if (!isRecord(message.changes)) {
    return { ok: false, error: 'updateSettings requires changes to be an object' };
  }
  updateSchedulerSettings(dependencies.getDatabase(), message.changes);
  return { ok: true, settings: getSchedulerSettings(dependencies.getDatabase()) };
}

function getRunHistory(dependencies: NativeHostDependencies): NativeHostReply {
  const { targetIntervalMinutes } = getSchedulerSettings(dependencies.getDatabase());
  const searches = stmtListSavedSearches(dependencies.getDatabase())
    .all()
    .filter((row) => row.should_alert_on_new_listings === 1)
    .map((row): RunHistoryEntry => {
      return {
        id: row.id,
        name: row.name,
        lastRunAtMs: row.last_run_at,
        lastRunSucceeded: row.last_run_succeeded === null ? null : row.last_run_succeeded === 1,
        lastRunDetailLines: (row.last_run_detail ?? '').split('\n').filter(Boolean),
        nextDueAtMs:
          row.last_run_at === null ? null : row.last_run_at + targetIntervalMinutes * 60_000,
      };
    });
  return { ok: true, searches };
}

function isValidLineCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_LOG_LINE_COUNT
  );
}

function subscribeLogs(
  message: UnvalidatedRequest<'subscribeLogs'>,
  dependencies: NativeHostDependencies
): NativeHostReply {
  if (!isValidLineCount(message.lineCount)) {
    return {
      ok: false,
      error: `subscribeLogs requires lineCount to be a whole number from 1 to ${MAX_LOG_LINE_COUNT}`,
    };
  }
  dependencies.logStreams.subscribe(message.lineCount);
  return { ok: true, isSubscribed: true };
}

async function getServices(dependencies: NativeHostDependencies): Promise<NativeHostReply> {
  const { definitionsByServiceName, userId, runLaunchctlAsync, doesFileExist } =
    dependencies.services;
  const installedStates = await Promise.all(
    Object.entries(definitionsByServiceName).map(async ([serviceName, definition]) => {
      const state = await getServiceStateAsync({ definition, userId, runLaunchctlAsync });
      const installedState: InstalledServiceState = {
        ...state,
        isInstalled: doesFileExist(definition.plistPath),
        isIntervalJob: definition.isIntervalJob,
      };
      return [serviceName, installedState] as const;
    })
  );
  return { ok: true, servicesByName: Object.fromEntries(installedStates) };
}

function isServiceAction(value: unknown): value is ServiceAction {
  return (SERVICE_ACTIONS as readonly unknown[]).includes(value);
}

async function controlService(
  message: UnvalidatedRequest<'controlService'>,
  dependencies: NativeHostDependencies
): Promise<NativeHostReply> {
  const { definitionsByServiceName, userId, runLaunchctlAsync, doesFileExist } =
    dependencies.services;
  const { serviceName, action } = message;
  if (typeof serviceName !== 'string' || !Object.hasOwn(definitionsByServiceName, serviceName)) {
    return { ok: false, error: `Unknown service: ${String(serviceName)}` };
  }
  if (!isServiceAction(action)) {
    return {
      ok: false,
      error: `Unknown action: ${String(action)} (use ${SERVICE_ACTIONS.join(', ')} for action)`,
    };
  }

  const definition = definitionsByServiceName[serviceName];
  // Starting an uninstalled service fails with launchd's unhelpful "Input/output error".
  if (action !== 'stop' && !doesFileExist(definition.plistPath)) {
    return {
      ok: false,
      error: `Service ${serviceName} is not installed (no ${definition.plistPath}). ${describeHowToInstallService(serviceName)}`,
    };
  }

  const state = await controlServiceAsync({
    action,
    definition,
    userId,
    runLaunchctlAsync,
  });
  return { ok: true, serviceName, state };
}

async function handleBatchedRequestAsync(
  request: unknown,
  dependencies: NativeHostDependencies
): Promise<NativeHostReply> {
  if (
    isRecord(request) &&
    isNativeHostRequestType(request.type) &&
    !isReadOnlyRequestType(request.type)
  ) {
    return {
      ok: false,
      error: `A batch cannot contain ${request.type} requests (only ${READ_ONLY_REQUEST_TYPES.join(', ')})`,
    };
  }
  return handleNativeHostMessageAsync(request, dependencies);
}

async function batchAsync(
  message: UnvalidatedRequest<'batch'>,
  dependencies: NativeHostDependencies
): Promise<NativeHostReply> {
  const { requests } = message;
  if (
    !Array.isArray(requests) ||
    requests.length === 0 ||
    requests.length > MAX_BATCH_REQUEST_COUNT
  ) {
    return {
      ok: false,
      error: `batch requires requests to be an array of 1 to ${MAX_BATCH_REQUEST_COUNT} requests`,
    };
  }
  const replies = await Promise.all(
    requests.map((request) => handleBatchedRequestAsync(request, dependencies))
  );
  return { ok: true, replies };
}

export async function handleNativeHostMessageAsync(
  message: unknown,
  dependencies: NativeHostDependencies
): Promise<NativeHostReply> {
  if (!isRecord(message) || typeof message.type !== 'string') {
    return { ok: false, error: 'Request must be an object with a string type' };
  }

  if (!isNativeHostRequestType(message.type)) {
    return { ok: false, error: `Unknown request type: ${message.type}` };
  }

  const requestType = message.type;
  try {
    switch (requestType) {
      case 'getStatus':
        return getStatus(dependencies);
      case 'syncCookies':
        return syncCookies(message, dependencies);
      case 'updateSettings':
        return updateSettings(message, dependencies);
      case 'getRunHistory':
        return getRunHistory(dependencies);
      case 'getServices':
        return await getServices(dependencies);
      case 'controlService':
        return await controlService(message, dependencies);
      case 'subscribeLogs':
        return subscribeLogs(message, dependencies);
      case 'batch':
        return await batchAsync(message, dependencies);
      default: {
        const unhandledRequestType: never = requestType;
        return { ok: false, error: `Unhandled request type: ${unhandledRequestType}` };
      }
    }
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
