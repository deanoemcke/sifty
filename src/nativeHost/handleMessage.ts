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
import {
  getSchedulerSettings,
  type SchedulerSettings,
  updateSchedulerSettings,
} from '../server/settings';

export type NativeHostDependencies = {
  database: Database.Database;
  // Absolute paths of the log files the extension may read, by name. A name
  // that is not here cannot be read.
  logFilePathsByLogName: Record<string, string>;
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
  | { ok: true; searches: RunHistoryEntry[] };

type MessageRecord = Record<string, unknown>;

function isMessageRecord(value: unknown): value is MessageRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStatus(dependencies: NativeHostDependencies): NativeHostReply {
  return {
    ok: true,
    cookies: getFacebookCookieStatus(dependencies.database),
    settings: getSchedulerSettings(dependencies.database),
  };
}

function syncCookies(
  message: MessageRecord,
  dependencies: NativeHostDependencies
): NativeHostReply {
  if (typeof message.cookiesJson !== 'string') {
    return { ok: false, error: 'syncCookies requires cookiesJson to be a string' };
  }
  saveFacebookCookies(dependencies.database, message.cookiesJson);
  return { ok: true, cookies: getFacebookCookieStatus(dependencies.database) };
}

function updateSettings(
  message: MessageRecord,
  dependencies: NativeHostDependencies
): NativeHostReply {
  if (!isMessageRecord(message.changes)) {
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

export async function handleNativeHostMessageAsync(
  message: unknown,
  dependencies: NativeHostDependencies
): Promise<NativeHostReply> {
  if (!isMessageRecord(message) || typeof message.type !== 'string') {
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
      default:
        return { ok: false, error: `Unknown request type: ${message.type}` };
    }
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
