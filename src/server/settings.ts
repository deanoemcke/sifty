// Server-side only — operator-tunable settings stored in sifty.db, read fresh
// by every scheduler run (the scheduler is a new process each tick, so there
// is no in-memory copy to keep in sync).

import type Database from 'better-sqlite3';

export type SchedulerSettings = {
  targetIntervalMinutes: number;
  maxSearchesPerTick: number;
};

export const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
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

type SettingRow = { key: string; value: string };

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
  const rows = database.prepare<[], SettingRow>('SELECT key, value FROM settings').all();
  const savedValuesByKey = new Map(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));

  return {
    targetIntervalMinutes:
      (savedValuesByKey.get('targetIntervalMinutes') as number | undefined) ??
      DEFAULT_SCHEDULER_SETTINGS.targetIntervalMinutes,
    maxSearchesPerTick:
      (savedValuesByKey.get('maxSearchesPerTick') as number | undefined) ??
      DEFAULT_SCHEDULER_SETTINGS.maxSearchesPerTick,
  };
}

export function updateSchedulerSettings(
  database: Database.Database,
  changes: Record<string, unknown>
): void {
  const validatedChanges = validateSchedulerSettingChanges(changes);
  const upsertSetting = database.prepare<[string, string, number]>(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  const nowMs = Date.now();

  database.transaction(() => {
    for (const [key, value] of Object.entries(validatedChanges)) {
      upsertSetting.run(key, JSON.stringify(value), nowMs);
    }
  })();
}
