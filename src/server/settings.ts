import type Database from 'better-sqlite3';
import { stmtListSettings, stmtUpsertSetting } from './db';

const MINUTES_PER_WEEK = 7 * 24 * 60;

const SCHEDULER_SETTING_DEFINITIONS = {
  targetIntervalMinutes: { defaultValue: 240, minimum: 1, maximum: MINUTES_PER_WEEK },
  maxSearchesPerTick: { defaultValue: 5, minimum: 1, maximum: 50 },
} as const;

export type SchedulerSettings = {
  -readonly [Key in keyof typeof SCHEDULER_SETTING_DEFINITIONS]: number;
};

function isSchedulerSettingKey(key: string): key is keyof SchedulerSettings {
  return Object.hasOwn(SCHEDULER_SETTING_DEFINITIONS, key);
}

function getDefaultSchedulerSettings(): SchedulerSettings {
  return Object.fromEntries(
    Object.entries(SCHEDULER_SETTING_DEFINITIONS).map(([key, { defaultValue }]) => [
      key,
      defaultValue,
    ])
  ) as SchedulerSettings;
}

function isValidSchedulerSettingValue(key: keyof SchedulerSettings, value: unknown): boolean {
  const { minimum, maximum } = SCHEDULER_SETTING_DEFINITIONS[key];
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function describeAcceptedSchedulerSettingValues(key: keyof SchedulerSettings): string {
  const { minimum, maximum } = SCHEDULER_SETTING_DEFINITIONS[key];
  return `${key} must be a whole number from ${minimum} to ${maximum}`;
}

function validateSchedulerSettingChanges(
  changes: Record<string, unknown>
): Partial<SchedulerSettings> {
  const validatedChanges: Partial<SchedulerSettings> = {};

  for (const [key, value] of Object.entries(changes)) {
    if (!isSchedulerSettingKey(key)) {
      throw new Error(`Unknown scheduler setting: ${key}`);
    }
    if (!isValidSchedulerSettingValue(key, value)) {
      throw new Error(`${describeAcceptedSchedulerSettingValues(key)}, got ${String(value)}`);
    }
    validatedChanges[key] = value as number;
  }

  return validatedChanges;
}

export function getSchedulerSettings(database: Database.Database): SchedulerSettings {
  const settings = getDefaultSchedulerSettings();
  for (const row of stmtListSettings(database).all()) {
    if (!isSchedulerSettingKey(row.key)) continue;

    let storedValue: unknown;
    try {
      storedValue = JSON.parse(row.value);
    } catch {
      storedValue = undefined;
    }

    if (isValidSchedulerSettingValue(row.key, storedValue)) {
      settings[row.key] = storedValue as number;
    } else {
      console.warn(
        `[settings] ignoring stored ${row.key} (${describeAcceptedSchedulerSettingValues(row.key)}, found ${row.value}); using default ${settings[row.key]}`
      );
    }
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
