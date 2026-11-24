import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  initSchema,
  stmtInsertSavedSearch,
  stmtUpdateSavedSearchLastRunAt,
  stmtUpdateSavedSearchRunStatus,
} from '../server/db';
import { getStoredFacebookCookiesJson } from '../server/facebookCookies';
import { getSchedulerSettings, updateSchedulerSettings } from '../server/settings';
import { handleNativeHostMessageAsync, type NativeHostDependencies } from './handleMessage';

function makeDependencies(overrides: Partial<NativeHostDependencies> = {}): NativeHostDependencies {
  const database = new Database(':memory:');
  initSchema(database);
  return { database, logFilePathsByLogName: {}, ...overrides };
}

const GOOD_COOKIES_JSON = JSON.stringify([{ name: 'c_user', value: '12345' }]);

describe('getStatus', () => {
  it('reports cookies as not synced and default settings on a fresh database', async () => {
    const reply = await handleNativeHostMessageAsync({ type: 'getStatus' }, makeDependencies());

    expect(reply).toEqual({
      ok: true,
      cookies: { isSynced: false },
      settings: { targetIntervalMinutes: 240, maxSearchesPerTick: 5 },
    });
  });
});

describe('syncCookies', () => {
  it('saves valid cookies and replies with the new cookie status, without any values', async () => {
    const dependencies = makeDependencies();

    const reply = await handleNativeHostMessageAsync(
      { type: 'syncCookies', cookiesJson: GOOD_COOKIES_JSON },
      dependencies
    );

    expect(reply).toMatchObject({
      ok: true,
      cookies: { isSynced: true, cookieCount: 1, syncedAtMs: expect.any(Number) },
    });
    expect(JSON.stringify(reply)).not.toContain('12345');
    expect(getStoredFacebookCookiesJson(dependencies.database)).toBe(GOOD_COOKIES_JSON);
  });

  it('replies with an error and keeps the previous cookies when the new set is invalid', async () => {
    const dependencies = makeDependencies();
    await handleNativeHostMessageAsync(
      { type: 'syncCookies', cookiesJson: GOOD_COOKIES_JSON },
      dependencies
    );

    const reply = await handleNativeHostMessageAsync(
      { type: 'syncCookies', cookiesJson: '[]' },
      dependencies
    );

    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('non-empty') });
    expect(getStoredFacebookCookiesJson(dependencies.database)).toBe(GOOD_COOKIES_JSON);
  });

  it('rejects a request whose cookiesJson is not a string', async () => {
    const reply = await handleNativeHostMessageAsync(
      { type: 'syncCookies', cookiesJson: [{ name: 'c_user' }] },
      makeDependencies()
    );

    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('cookiesJson') });
  });
});

describe('updateSettings', () => {
  it('saves valid changes and replies with the resulting settings', async () => {
    const dependencies = makeDependencies();

    const reply = await handleNativeHostMessageAsync(
      { type: 'updateSettings', changes: { targetIntervalMinutes: 60 } },
      dependencies
    );

    expect(reply).toEqual({
      ok: true,
      settings: { targetIntervalMinutes: 60, maxSearchesPerTick: 5 },
    });
    expect(getSchedulerSettings(dependencies.database).targetIntervalMinutes).toBe(60);
  });

  it('replies with an error naming the setting when a change is invalid, saving nothing', async () => {
    const dependencies = makeDependencies();

    const reply = await handleNativeHostMessageAsync(
      { type: 'updateSettings', changes: { targetIntervalMinutes: 60, maxSearchesPerTick: 0 } },
      dependencies
    );

    expect(reply).toMatchObject({
      ok: false,
      error: expect.stringContaining('maxSearchesPerTick'),
    });
    expect(getSchedulerSettings(dependencies.database).targetIntervalMinutes).toBe(240);
  });

  it('rejects a request whose changes is not an object', async () => {
    const reply = await handleNativeHostMessageAsync(
      { type: 'updateSettings', changes: 'fast' },
      makeDependencies()
    );

    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('changes') });
  });
});

function insertSearch(
  database: Database.Database,
  id: string,
  options: { isAlertEnabled?: boolean; createdAtMs?: number } = {}
): void {
  stmtInsertSavedSearch(database).run(
    id,
    `Search ${id}`,
    JSON.stringify(['https://example.com/search']),
    null,
    null,
    options.createdAtMs ?? 1,
    options.isAlertEnabled === false ? 0 : 1
  );
}

describe('getRunHistory', () => {
  it('reports no searches when none exist', async () => {
    const reply = await handleNativeHostMessageAsync({ type: 'getRunHistory' }, makeDependencies());

    expect(reply).toEqual({ ok: true, searches: [] });
  });

  it('lists only alert-enabled searches', async () => {
    const dependencies = makeDependencies();
    insertSearch(dependencies.database, 'alerting');
    insertSearch(dependencies.database, 'silent', { isAlertEnabled: false });

    const reply = await handleNativeHostMessageAsync({ type: 'getRunHistory' }, dependencies);

    expect(reply).toMatchObject({
      ok: true,
      searches: [{ id: 'alerting', name: 'Search alerting' }],
    });
    expect((reply as { searches: unknown[] }).searches).toHaveLength(1);
  });

  it('reports a never-run search as having no last run and no scheduled time', async () => {
    const dependencies = makeDependencies();
    insertSearch(dependencies.database, 'fresh');

    const reply = await handleNativeHostMessageAsync({ type: 'getRunHistory' }, dependencies);

    expect(reply).toEqual({
      ok: true,
      searches: [
        {
          id: 'fresh',
          name: 'Search fresh',
          lastRunAtMs: null,
          lastRunSucceeded: null,
          lastRunDetailLines: [],
          nextDueAtMs: null,
        },
      ],
    });
  });

  it('reports the last run, its failure detail, and when the next run is due', async () => {
    const dependencies = makeDependencies();
    insertSearch(dependencies.database, 'failing');
    const lastRunAtMs = 1_699_990_000_000;
    stmtUpdateSavedSearchLastRunAt(dependencies.database).run(lastRunAtMs, 'failing');
    stmtUpdateSavedSearchRunStatus(dependencies.database).run(
      0,
      'scrape:Timed out\nai-filter:Rate limited',
      null,
      'failing'
    );
    updateSchedulerSettings(dependencies.database, { targetIntervalMinutes: 60 });

    const reply = await handleNativeHostMessageAsync({ type: 'getRunHistory' }, dependencies);

    expect(reply).toMatchObject({
      ok: true,
      searches: [
        {
          lastRunAtMs,
          lastRunSucceeded: false,
          lastRunDetailLines: ['scrape:Timed out', 'ai-filter:Rate limited'],
          nextDueAtMs: lastRunAtMs + 60 * 60_000,
        },
      ],
    });
  });

  it('reports a successful last run as succeeded', async () => {
    const dependencies = makeDependencies();
    insertSearch(dependencies.database, 'ok');
    stmtUpdateSavedSearchLastRunAt(dependencies.database).run(1_699_990_000_000, 'ok');
    stmtUpdateSavedSearchRunStatus(dependencies.database).run(1, null, null, 'ok');

    const reply = await handleNativeHostMessageAsync({ type: 'getRunHistory' }, dependencies);

    expect(reply).toMatchObject({
      searches: [{ lastRunSucceeded: true, lastRunDetailLines: [] }],
    });
  });
});

describe('malformed requests', () => {
  it.each([
    ['null', null],
    ['a string', 'getStatus'],
    ['an array', ['getStatus']],
    ['an object without a type', { id: 1 }],
    ['an unknown type', { type: 'formatDisk' }],
  ])('replies with an error instead of throwing for %s', async (_description, message) => {
    const reply = await handleNativeHostMessageAsync(message, makeDependencies());

    expect(reply).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
