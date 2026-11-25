// Handles one request from the Sifty Server extension. Requests come from
// outside the process, so everything is validated here, and every failure —
// including exceptions from the store — becomes an `{ ok: false, error }`
// reply rather than a crash, so the extension always gets an answer.

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
import { isRecord, type UnknownRecord } from './isRecord';
import { readLogTail } from './readLogTail';
import type { ServiceState } from './serviceState';

const MAX_TAIL_LINE_COUNT = 500;

// A service's launchd state, plus whether its plist has been installed — a
// service that was never installed looks identical to a stopped one otherwise.
export type InstalledServiceState = ServiceState & { isInstalled: boolean };

export type NativeHostServices = {
  // The only services the extension may control, by the name it uses. The label
  // and plist path come from here, never from a request.
  definitionsByServiceName: Record<string, ServiceDefinition>;
  userId: number;
  runLaunchctlAsync: RunLaunchctl;
  doesFileExist: (filePath: string) => boolean;
};

export type NativeHostDependencies = {
  database: Database.Database;
  // Absolute paths of the log files the extension may read, by name. A name
  // that is not here cannot be read.
  logFilePathsByLogName: Record<string, string>;
  services: NativeHostServices;
};

export type RunHistoryEntry = {
  id: string;
  name: string;
  lastRunAtMs: number | null;
  lastRunSucceeded: boolean | null;
  // One entry per `${kind}:${message}` line the scheduler recorded for the run.
  lastRunDetailLines: string[];
  // null until the search has run once: it is due on the next scheduler run.
  nextDueAtMs: number | null;
};

export type NativeHostReply =
  | { ok: false; error: string }
  | { ok: true; cookies: FacebookCookieStatus; settings: SchedulerSettings }
  | { ok: true; cookies: FacebookCookieStatus }
  | { ok: true; settings: SchedulerSettings }
  | { ok: true; searches: RunHistoryEntry[] }
  | { ok: true; isLogFilePresent: boolean; logLines: string[] }
  | { ok: true; servicesByName: Record<string, InstalledServiceState> }
  | { ok: true; serviceName: string; state: ServiceState };

function getStatus(dependencies: NativeHostDependencies): NativeHostReply {
  return {
    ok: true,
    cookies: getFacebookCookieStatus(dependencies.database),
    settings: getSchedulerSettings(dependencies.database),
  };
}

function syncCookies(
  message: UnknownRecord,
  dependencies: NativeHostDependencies
): NativeHostReply {
  if (typeof message.cookiesJson !== 'string') {
    return { ok: false, error: 'syncCookies requires cookiesJson to be a string' };
  }
  saveFacebookCookies(dependencies.database, message.cookiesJson);
  return { ok: true, cookies: getFacebookCookieStatus(dependencies.database) };
}

function updateSettings(
  message: UnknownRecord,
  dependencies: NativeHostDependencies
): NativeHostReply {
  if (!isRecord(message.changes)) {
    return { ok: false, error: 'updateSettings requires changes to be an object' };
  }
  updateSchedulerSettings(dependencies.database, message.changes);
  return { ok: true, settings: getSchedulerSettings(dependencies.database) };
}

function getRunHistory(dependencies: NativeHostDependencies): NativeHostReply {
  const { targetIntervalMinutes } = getSchedulerSettings(dependencies.database);
  const searches = stmtListSavedSearches(dependencies.database)
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

function tailLog(message: UnknownRecord, dependencies: NativeHostDependencies): NativeHostReply {
  const { logName, lineCount } = message;
  // Only names configured by the host's own code resolve to a path; the
  // request never supplies one.
  if (typeof logName !== 'string' || !Object.hasOwn(dependencies.logFilePathsByLogName, logName)) {
    return { ok: false, error: `Unknown log: ${String(logName)}` };
  }
  if (
    typeof lineCount !== 'number' ||
    !Number.isInteger(lineCount) ||
    lineCount < 1 ||
    lineCount > MAX_TAIL_LINE_COUNT
  ) {
    return {
      ok: false,
      error: `tailLog requires lineCount to be a whole number from 1 to ${MAX_TAIL_LINE_COUNT}`,
    };
  }

  const logTail = readLogTail(dependencies.logFilePathsByLogName[logName], lineCount);
  return { ok: true, ...logTail };
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
  message: UnknownRecord,
  dependencies: NativeHostDependencies
): Promise<NativeHostReply> {
  const { definitionsByServiceName, userId, runLaunchctlAsync, doesFileExist } =
    dependencies.services;
  const { serviceName, action } = message;
  // Only names the host configured resolve to a launchd label; the request
  // never supplies a label, path or command.
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
  // Stopping an uninstalled service is harmless, but starting one would fail
  // with launchd's unhelpful "Input/output error".
  if (action !== 'stop' && !doesFileExist(definition.plistPath)) {
    return {
      ok: false,
      error: `Service ${serviceName} is not installed (no ${definition.plistPath}). Run npm run services:install first.`,
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

export async function handleNativeHostMessageAsync(
  message: unknown,
  dependencies: NativeHostDependencies
): Promise<NativeHostReply> {
  if (!isRecord(message) || typeof message.type !== 'string') {
    return { ok: false, error: 'Request must be an object with a string type' };
  }

  try {
    switch (message.type) {
      case 'getStatus':
        return getStatus(dependencies);
      case 'syncCookies':
        return syncCookies(message, dependencies);
      case 'updateSettings':
        return updateSettings(message, dependencies);
      case 'getRunHistory':
        return getRunHistory(dependencies);
      case 'tailLog':
        return tailLog(message, dependencies);
      case 'getServices':
        return await getServices(dependencies);
      case 'controlService':
        return await controlService(message, dependencies);
      default:
        return { ok: false, error: `Unknown request type: ${message.type}` };
    }
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
