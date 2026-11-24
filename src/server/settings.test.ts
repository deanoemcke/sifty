import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from './db';
import { getSchedulerSettings, updateSchedulerSettings } from './settings';

function freshDb(): Database.Database {
  const database = new Database(':memory:');
  initSchema(database);
  return database;
}

describe('updateSchedulerSettings validation', () => {
  it.each([
    ['zero interval', { targetIntervalMinutes: 0 }, /targetIntervalMinutes/],
    ['negative interval', { targetIntervalMinutes: -5 }, /targetIntervalMinutes/],
    ['fractional interval', { targetIntervalMinutes: 1.5 }, /targetIntervalMinutes/],
    ['interval longer than a week', { targetIntervalMinutes: 10_081 }, /targetIntervalMinutes/],
    ['non-numeric interval', { targetIntervalMinutes: '60' }, /targetIntervalMinutes/],
    ['zero searches per tick', { maxSearchesPerTick: 0 }, /maxSearchesPerTick/],
    ['more than fifty searches per tick', { maxSearchesPerTick: 51 }, /maxSearchesPerTick/],
    ['an unknown setting', { notARealSetting: 1 }, /notARealSetting/],
  ])('rejects %s and names the offending setting', (_description, changes, expectedMessage) => {
    const database = freshDb();

    expect(() => updateSchedulerSettings(database, changes)).toThrow(expectedMessage);
  });

  it('stores nothing when any one setting in the update is invalid', () => {
    const database = freshDb();

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
    expect(getSchedulerSettings(freshDb())).toEqual({
      targetIntervalMinutes: 240,
      maxSearchesPerTick: 5,
    });
  });

  it('returns saved values on later reads, leaving unsaved settings at their defaults', () => {
    const database = freshDb();

    updateSchedulerSettings(database, { targetIntervalMinutes: 60 });

    expect(getSchedulerSettings(database)).toEqual({
      targetIntervalMinutes: 60,
      maxSearchesPerTick: 5,
    });
  });

  it('keeps earlier saved values when a later update changes a different setting', () => {
    const database = freshDb();

    updateSchedulerSettings(database, { targetIntervalMinutes: 60 });
    updateSchedulerSettings(database, { maxSearchesPerTick: 2 });

    expect(getSchedulerSettings(database)).toEqual({
      targetIntervalMinutes: 60,
      maxSearchesPerTick: 2,
    });
  });
});
