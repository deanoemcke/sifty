import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  getSchedulerSettings,
  SCHEDULER_TICK_INTERVAL_MINUTES,
  updateSchedulerSettings,
} from './settings';
import { createFreshDatabase } from './testDatabase';

describe('updateSchedulerSettings validation', () => {
  it.each([
    ['zero interval', { targetIntervalMinutes: 0 }, /targetIntervalMinutes/],
    ['negative interval', { targetIntervalMinutes: -5 }, /targetIntervalMinutes/],
    ['fractional interval', { targetIntervalMinutes: 1.5 }, /targetIntervalMinutes/],
    [
      'interval shorter than the scheduler tick',
      { targetIntervalMinutes: SCHEDULER_TICK_INTERVAL_MINUTES - 1 },
      /targetIntervalMinutes/,
    ],
    ['interval longer than a week', { targetIntervalMinutes: 10_081 }, /targetIntervalMinutes/],
    ['non-numeric interval', { targetIntervalMinutes: '60' }, /targetIntervalMinutes/],
    ['zero searches per tick', { maxSearchesPerTick: 0 }, /maxSearchesPerTick/],
    ['more than fifty searches per tick', { maxSearchesPerTick: 51 }, /maxSearchesPerTick/],
    ['an unknown setting', { notARealSetting: 1 }, /notARealSetting/],
  ])('rejects %s and names the offending setting', (_description, changes, expectedMessage) => {
    const database = createFreshDatabase();

    expect(() => updateSchedulerSettings(database, changes)).toThrow(expectedMessage);
  });

  it('accepts an interval equal to the scheduler tick', () => {
    const database = createFreshDatabase();

    updateSchedulerSettings(database, {
      targetIntervalMinutes: SCHEDULER_TICK_INTERVAL_MINUTES,
    });

    expect(getSchedulerSettings(database).targetIntervalMinutes).toBe(
      SCHEDULER_TICK_INTERVAL_MINUTES
    );
  });

  it('stores nothing when any one setting in the update is invalid', () => {
    const database = createFreshDatabase();

    expect(() =>
      updateSchedulerSettings(database, { targetIntervalMinutes: 60, maxSearchesPerTick: 0 })
    ).toThrow(/maxSearchesPerTick/);

    expect(getSchedulerSettings(database)).toEqual({
      targetIntervalMinutes: 240,
      maxSearchesPerTick: 5,
    });
  });
});

describe('getSchedulerSettings', () => {
  it('returns the defaults when nothing has been saved', () => {
    expect(getSchedulerSettings(createFreshDatabase())).toEqual({
      targetIntervalMinutes: 240,
      maxSearchesPerTick: 5,
    });
  });

  it('returns saved values on later reads, leaving unsaved settings at their defaults', () => {
    const database = createFreshDatabase();

    updateSchedulerSettings(database, { targetIntervalMinutes: 60 });

    expect(getSchedulerSettings(database)).toEqual({
      targetIntervalMinutes: 60,
      maxSearchesPerTick: 5,
    });
  });

  it('keeps earlier saved values when a later update changes a different setting', () => {
    const database = createFreshDatabase();

    updateSchedulerSettings(database, { targetIntervalMinutes: 60 });
    updateSchedulerSettings(database, { maxSearchesPerTick: 2 });

    expect(getSchedulerSettings(database)).toEqual({
      targetIntervalMinutes: 60,
      maxSearchesPerTick: 2,
    });
  });
});

describe('getSchedulerSettings with unusable stored values', () => {
  function storeRawSetting(database: Database.Database, key: string, rawValue: string): void {
    database
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)')
      .run(key, rawValue);
  }

  it.each([
    ['non-JSON text', 'abc'],
    ['zero (below the minimum)', '0'],
    ['a value above the maximum', '51'],
    ['a fractional number', '2.5'],
    ['a JSON string', '"abc"'],
  ])('falls back to the default and warns when maxSearchesPerTick is %s', (_description, rawValue) => {
    const database = createFreshDatabase();
    storeRawSetting(database, 'maxSearchesPerTick', rawValue);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getSchedulerSettings(database).maxSearchesPerTick).toBe(5);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('maxSearchesPerTick'));

    warnSpy.mockRestore();
  });

  it('keeps a valid stored setting when another stored setting is unusable', () => {
    const database = createFreshDatabase();
    storeRawSetting(database, 'maxSearchesPerTick', 'abc');
    storeRawSetting(database, 'targetIntervalMinutes', '60');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getSchedulerSettings(database)).toEqual({
      targetIntervalMinutes: 60,
      maxSearchesPerTick: 5,
    });

    warnSpy.mockRestore();
  });
});
