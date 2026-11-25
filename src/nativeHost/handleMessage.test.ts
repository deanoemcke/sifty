import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initSchema,
  stmtInsertSavedSearch,
  stmtUpdateSavedSearchLastRunAt,
  stmtUpdateSavedSearchRunStatus,
} from '../server/db';
import { getStoredFacebookCookiesJson } from '../server/facebookCookies';
import { getSchedulerSettings, updateSchedulerSettings } from '../server/settings';
import { makeFakeLaunchd } from './fakeLaunchd';
import { handleNativeHostMessageAsync, type NativeHostDependencies } from './handleMessage';

function makeDependencies(overrides: Partial<NativeHostDependencies> = {}): NativeHostDependencies {
  const database = new Database(':memory:');
  initSchema(database);
  return {
    database,
    logFilePathsByLogName: {},
    services: {
      definitionsByServiceName: {},
      userId: 501,
      runLaunchctlAsync: async () => ({
        exitCode: 1,
        output: 'launchctl is not available in this test',
      }),
      doesFileExist: () => true,
    },
    ...overrides,
  };
}

const GOOD_COOKIES_JSON = JSON.stringify([
  { name: 'c_user', value: '12345' },
  { name: 'xs', value: '67890' },
]);

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
      cookies: {
        isSynced: true,
        isLoginUsable: true,
        cookieCount: 2,
        syncedAtMs: expect.any(Number),
      },
    });
    expect(JSON.stringify(reply)).not.toContain('12345');
    expect(JSON.stringify(reply)).not.toContain('67890');
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

describe('tailLog', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeLogDependencies(logContents: string | undefined): NativeHostDependencies {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sifty-native-host-test-'));
    temporaryDirectories.push(directory);
    const logPath = path.join(directory, 'scheduler.log');
    if (logContents !== undefined) fs.writeFileSync(logPath, logContents);
    return makeDependencies({ logFilePathsByLogName: { scheduler: logPath } });
  }

  it('returns the last requested lines of a known log, oldest first', async () => {
    const dependencies = makeLogDependencies('one\ntwo\nthree\nfour\n');

    const reply = await handleNativeHostMessageAsync(
      { type: 'tailLog', logName: 'scheduler', lineCount: 2 },
      dependencies
    );

    expect(reply).toEqual({ ok: true, isLogFilePresent: true, logLines: ['three', 'four'] });
  });

  it('returns every line when the log has fewer than requested', async () => {
    const dependencies = makeLogDependencies('one\ntwo\n');

    const reply = await handleNativeHostMessageAsync(
      { type: 'tailLog', logName: 'scheduler', lineCount: 50 },
      dependencies
    );

    expect(reply).toMatchObject({ logLines: ['one', 'two'] });
  });

  it('reports a log file that does not exist yet as absent, not as an error', async () => {
    const dependencies = makeLogDependencies(undefined);

    const reply = await handleNativeHostMessageAsync(
      { type: 'tailLog', logName: 'scheduler', lineCount: 10 },
      dependencies
    );

    expect(reply).toEqual({ ok: true, isLogFilePresent: false, logLines: [] });
  });

  it('reads only the end of a very large log and never returns a partial first line', async () => {
    const numberedLines = Array.from({ length: 60_000 }, (_, index) => `line ${index}`);
    const dependencies = makeLogDependencies(`${numberedLines.join('\n')}\n`);

    const reply = await handleNativeHostMessageAsync(
      { type: 'tailLog', logName: 'scheduler', lineCount: 500 },
      dependencies
    );

    expect(reply).toMatchObject({ ok: true, isLogFilePresent: true });
    const { logLines } = reply as { logLines: string[] };
    expect(logLines).toHaveLength(500);
    expect(logLines.at(-1)).toBe('line 59999');
    expect(logLines.at(0)).toBe('line 59500');
  });

  it('rejects a log name that is not configured, without touching the filesystem', async () => {
    const reply = await handleNativeHostMessageAsync(
      { type: 'tailLog', logName: '../../etc/passwd', lineCount: 10 },
      makeLogDependencies('secret\n')
    );

    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('Unknown log') });
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 2.5],
    ['more than 500', 501],
    ['a string', '10'],
    ['missing', undefined],
  ])('rejects a lineCount that is %s', async (_description, lineCount) => {
    const reply = await handleNativeHostMessageAsync(
      { type: 'tailLog', logName: 'scheduler', lineCount },
      makeLogDependencies('one\n')
    );

    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('lineCount') });
  });
});

const WEBAPP_PLIST = '/agents/webapp.plist';
const NGROK_PLIST = '/agents/ngrok.plist';

function makeServiceDependencies(
  failures: Record<string, string> = {},
  doesFileExist: (filePath: string) => boolean = () => true
) {
  const fake = makeFakeLaunchd(
    {
      'ai.openclaw.sifty-webapp': {
        plistPath: WEBAPP_PLIST,
        isLoaded: true,
        isEnabled: true,
        pid: 4242,
      },
      'ai.openclaw.sifty-ngrok': {
        plistPath: NGROK_PLIST,
        isLoaded: false,
        isEnabled: false,
        pid: null,
      },
    },
    failures
  );
  const dependencies = makeDependencies({
    services: {
      definitionsByServiceName: {
        webapp: { label: 'ai.openclaw.sifty-webapp', plistPath: WEBAPP_PLIST },
        ngrok: { label: 'ai.openclaw.sifty-ngrok', plistPath: NGROK_PLIST },
      },
      userId: 501,
      runLaunchctlAsync: fake.runLaunchctlAsync,
      doesFileExist,
    },
  });
  return { dependencies, fake };
}

describe('getServices', () => {
  it('reports the state of every configured service by name', async () => {
    const { dependencies } = makeServiceDependencies();

    const reply = await handleNativeHostMessageAsync({ type: 'getServices' }, dependencies);

    expect(reply).toEqual({
      ok: true,
      servicesByName: {
        webapp: { isLoaded: true, isRunning: true, isEnabled: true, pid: 4242, isInstalled: true },
        ngrok: {
          isLoaded: false,
          isRunning: false,
          isEnabled: false,
          pid: null,
          isInstalled: true,
        },
      },
    });
  });

  it('reports a service whose plist has not been installed yet', async () => {
    const { dependencies } = makeServiceDependencies({}, (filePath) => filePath !== NGROK_PLIST);

    const reply = await handleNativeHostMessageAsync({ type: 'getServices' }, dependencies);

    expect(reply).toMatchObject({
      servicesByName: { webapp: { isInstalled: true }, ngrok: { isInstalled: false } },
    });
  });

  it('replies with an error when launchctl cannot be read', async () => {
    const { dependencies } = makeServiceDependencies({ list: 'launchctl exploded' });

    const reply = await handleNativeHostMessageAsync({ type: 'getServices' }, dependencies);

    expect(reply).toMatchObject({
      ok: false,
      error: expect.stringContaining('launchctl exploded'),
    });
  });
});

describe('controlService', () => {
  it('starts a stopped service and replies with its new state', async () => {
    const { dependencies } = makeServiceDependencies();

    const reply = await handleNativeHostMessageAsync(
      { type: 'controlService', serviceName: 'ngrok', action: 'start' },
      dependencies
    );

    expect(reply).toMatchObject({
      ok: true,
      serviceName: 'ngrok',
      state: { isLoaded: true, isRunning: true, isEnabled: true },
    });
  });

  it('stops a running service and parks it disabled', async () => {
    const { dependencies } = makeServiceDependencies();

    const reply = await handleNativeHostMessageAsync(
      { type: 'controlService', serviceName: 'webapp', action: 'stop' },
      dependencies
    );

    expect(reply).toMatchObject({
      ok: true,
      serviceName: 'webapp',
      state: { isLoaded: false, isEnabled: false },
    });
  });

  it.each([
    [
      'an unknown service',
      { serviceName: 'database', action: 'stop' },
      /Unknown service: database/,
    ],
    [
      'a prototype property as the service',
      { serviceName: 'constructor', action: 'stop' },
      /Unknown service/,
    ],
    ['a path as the service', { serviceName: '../../bin/sh', action: 'stop' }, /Unknown service/],
    ['an unknown action', { serviceName: 'webapp', action: 'delete' }, /Unknown action: delete/],
    ['a missing action', { serviceName: 'webapp' }, /action/],
    ['a non-string service', { serviceName: 7, action: 'stop' }, /Unknown service/],
  ])('rejects %s without running any launchctl command', async (_description, fields, expectedMessage) => {
    const { dependencies, fake } = makeServiceDependencies();

    const reply = await handleNativeHostMessageAsync(
      { type: 'controlService', ...fields },
      dependencies
    );

    expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(expectedMessage) });
    expect(fake.commands).toEqual([]);
  });

  it('refuses to start a service that is not installed, saying how to install it', async () => {
    const { dependencies, fake } = makeServiceDependencies({}, () => false);

    const reply = await handleNativeHostMessageAsync(
      { type: 'controlService', serviceName: 'ngrok', action: 'start' },
      dependencies
    );

    expect(reply).toMatchObject({
      ok: false,
      error: expect.stringContaining('npm run services:install'),
    });
    expect(fake.commands).toEqual([]);
  });

  it("replies with launchctl's own message when a step fails", async () => {
    const { dependencies } = makeServiceDependencies({ enable: 'Could not enable service' });

    const reply = await handleNativeHostMessageAsync(
      { type: 'controlService', serviceName: 'ngrok', action: 'start' },
      dependencies
    );

    expect(reply).toMatchObject({
      ok: false,
      error: expect.stringContaining('Could not enable service'),
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
