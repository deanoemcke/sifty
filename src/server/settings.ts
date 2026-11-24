// Server-side only — operator-tunable settings stored in sifty.db, read fresh
// by every scheduler run (the scheduler is a new process each tick, so there
// is no in-memory copy to keep in sync).

import type Database from 'better-sqlite3';
import { stmtListSettings, stmtUpsertSetting } from './db';

export type SchedulerSettings = {
  targetIntervalMinutes: number;
  maxSearchesPerTick: number;
};

// targetIntervalMinutes: no alert-enabled saved search should go longer than
// this between runs. That only holds if the external tick interval (launchd's
// StartInterval in ai.openclaw.sifty-scheduler.plist, currently 1800s/30min)
// stays well below it — nothing keeps the plist value and this setting in sync.
//
// maxSearchesPerTick: caps how many due searches one tick processes, so a large
// backlog (e.g. many searches added at once) can't turn a tick into an
// unbounded scraping burst. The rest is processed over later ticks, oldest
// (most overdue) first, so it self-heals rather than starving anything.
const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
  targetIntervalMinutes: 240,
  maxSearchesPerTick: 5,
};

const MINUTES_PER_WEEK = 7 * 24 * 60;

// The single source of truth for which settings exist and what values they
// accept — the allowed keys for updateSchedulerSettings are derived from it.
const SCHEDULER_SETTING_BOUNDS: Record<
  keyof SchedulerSettings,
  { minimum: number; maximum: number }
> = {
  targetIntervalMinutes: { minimum: 1, maximum: MINUTES_PER_WEEK },
  maxSearchesPerTick: { minimum: 1, maximum: 50 },
};

function isSchedulerSettingKey(key: string): key is keyof SchedulerSettings {
  return Object.hasOwn(SCHEDULER_SETTING_BOUNDS, key);
}

// Changes arrive from outside the process (the extension's native host), so
// they are validated here rather than trusted: unknown keys, non-integers and
// out-of-range values throw naming the offending setting.
function validateSchedulerSettingChanges(
  changes: Record<string, unknown>
): Partial<SchedulerSettings> {
  const validatedChanges: Partial<SchedulerSettings> = {};

  for (const [key, value] of Object.entries(changes)) {
    if (!isSchedulerSettingKey(key)) {
      throw new Error(`Unknown scheduler setting: ${key}`);
    }
    const { minimum, maximum } = SCHEDULER_SETTING_BOUNDS[key];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new Error(
        `${key} must be a whole number from ${minimum} to ${maximum}, got ${String(value)}`
      );
    }
    validatedChanges[key] = value;
  }

  return validatedChanges;
}

export function getSchedulerSettings(database: Database.Database): SchedulerSettings {
  const settings = { ...DEFAULT_SCHEDULER_SETTINGS };
  for (const row of stmtListSettings(database).all()) {
    if (isSchedulerSettingKey(row.key)) settings[row.key] = JSON.parse(row.value) as number;
  }
  return settings;
}

export function updateSchedulerSettings(
  database: Database.Database,
  changes: Record<string, unknown>
): void {
  const validatedChanges = validateSchedulerSettingChanges(changes);
  const upsertSetting = stmtUpsertSetting(database);
  const nowMs = Date.now();

  database.transaction(() => {
    for (const [key, value] of Object.entries(validatedChanges)) {
      upsertSetting.run(key, JSON.stringify(value), nowMs);
    }
  })();
}
