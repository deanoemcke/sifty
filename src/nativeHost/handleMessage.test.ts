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
import {
  handleNativeHostMessageAsync,
  MAX_BATCH_REQUEST_COUNT,
  type NativeHostDependencies,
} from './handleMessage';

function makeDependencies(overrides: Partial<NativeHostDependencies> = {}): NativeHostDependencies {
  const database = new Database(':memory:');
  initSchema(database);
  return {
    getDatabase: () => database,
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
    expect(getStoredFacebookCookiesJson(dependencies.getDatabase())).toBe(GOOD_COOKIES_JSON);
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
    expect(getStoredFacebookCookiesJson(dependencies.getDatabase())).toBe(GOOD_COOKIES_JSON);
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
    expect(getSchedulerSettings(dependencies.getDatabase()).targetIntervalMinutes).toBe(60);
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
    expect(getSchedulerSettings(dependencies.getDatabase()).targetIntervalMinutes).toBe(240);
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
    insertSearch(dependencies.getDatabase(), 'alerting');
    insertSearch(dependencies.getDatabase(), 'silent', { isAlertEnabled: false });

    const reply = await handleNativeHostMessageAsync({ type: 'getRunHistory' }, dependencies);

    expect(reply).toMatchObject({
      ok: true,
      searches: [{ id: 'alerting', name: 'Search alerting' }],
    });
    expect((reply as { searches: unknown[] }).searches).toHaveLength(1);
  });

  it('reports a never-run search as having no last run and no scheduled time', async () => {
    const dependencies = makeDependencies();
    insertSearch(dependencies.getDatabase(), 'fresh');

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
    insertSearch(dependencies.getDatabase(), 'failing');
    const lastRunAtMs = 1_699_990_000_000;
    stmtUpdateSavedSearchLastRunAt(dependencies.getDatabase()).run(lastRunAtMs, 'failing');
    stmtUpdateSavedSearchRunStatus(dependencies.getDatabase()).run(
      0,
      'scrape:Timed out\nai-filter:Rate limited',
      null,
      'failing'
    );
    updateSchedulerSettings(dependencies.getDatabase(), { targetIntervalMinutes: 60 });

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
    insertSearch(dependencies.getDatabase(), 'ok');
    stmtUpdateSavedSearchLastRunAt(dependencies.getDatabase()).run(1_699_990_000_000, 'ok');
    stmtUpdateSavedSearchRunStatus(dependencies.getDatabase()).run(1, null, null, 'ok');

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
        webapp: {
          label: 'ai.openclaw.sifty-webapp',
          plistPath: WEBAPP_PLIST,
          isIntervalJob: false,
        },
        ngrok: { label: 'ai.openclaw.sifty-ngrok', plistPath: NGROK_PLIST, isIntervalJob: false },
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
        webapp: {
          isLoaded: true,
          isRunning: true,
          isEnabled: true,
          pid: 4242,
          isInstalled: true,
          isIntervalJob: false,
        },
        ngrok: {
          isLoaded: false,
          isRunning: false,
          isEnabled: false,
          pid: null,
          isInstalled: true,
          isIntervalJob: false,
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

  it('tells the extension which services are interval jobs', async () => {
    const { dependencies } = makeServiceDependencies();
    dependencies.services.definitionsByServiceName.ngrok.isIntervalJob = true;

    const reply = await handleNativeHostMessageAsync({ type: 'getServices' }, dependencies);

    expect(reply).toMatchObject({
      servicesByName: { webapp: { isIntervalJob: false }, ngrok: { isIntervalJob: true } },
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

  it('does not advise npm run services:install for the scheduler, which it cannot install', async () => {
    const { dependencies, fake } = makeServiceDependencies({}, () => false);
    dependencies.services.definitionsByServiceName.scheduler = {
      label: 'ai.openclaw.sifty-scheduler',
      plistPath: '/x/ai.openclaw.sifty-scheduler.plist',
      isIntervalJob: true,
    };

    const reply = await handleNativeHostMessageAsync(
      { type: 'controlService', serviceName: 'scheduler', action: 'start' },
      dependencies
    );

    expect(reply).toMatchObject({ ok: false });
    expect(JSON.stringify(reply)).not.toContain('npm run services:install');
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

function throwDatabaseLocked(): never {
  throw new Error('database is locked');
}

describe('when the database cannot be opened', () => {
  it('still reports service state, which does not use the database', async () => {
    const { dependencies } = makeServiceDependencies();

    const reply = await handleNativeHostMessageAsync(
      { type: 'getServices' },
      { ...dependencies, getDatabase: throwDatabaseLocked }
    );

    expect(reply).toMatchObject({ ok: true });
  });

  it('answers a request that needs the database with an error reply', async () => {
    const reply = await handleNativeHostMessageAsync(
      { type: 'getStatus' },
      makeDependencies({ getDatabase: throwDatabaseLocked })
    );

    expect(reply).toEqual({ ok: false, error: 'database is locked' });
  });
});

describe('batch', () => {
  it('answers each request in order with the reply it would get on its own', async () => {
    const dependencies = makeDependencies();
    const requests = [{ type: 'getStatus' }, { type: 'getRunHistory' }];

    const reply = await handleNativeHostMessageAsync({ type: 'batch', requests }, dependencies);

    expect(reply).toEqual({
      ok: true,
      replies: [
        await handleNativeHostMessageAsync({ type: 'getStatus' }, dependencies),
        { ok: true, searches: [] },
      ],
    });
  });

  it('keeps one failing request from affecting the others', async () => {
    const reply = await handleNativeHostMessageAsync(
      {
        type: 'batch',
        requests: [
          { type: 'getRunHistory' },
          { type: 'tailLog', logName: 'missing', lineCount: 10 },
          { type: 'formatDisk' },
          { type: 'getRunHistory' },
        ],
      },
      makeDependencies()
    );

    expect(reply).toEqual({
      ok: true,
      replies: [
        { ok: true, searches: [] },
        { ok: false, error: 'Unknown log: missing' },
        { ok: false, error: 'Unknown request type: formatDisk' },
        { ok: true, searches: [] },
      ],
    });
  });

  it('isolates a request whose handler throws', async () => {
    const { dependencies } = makeServiceDependencies();

    const reply = await handleNativeHostMessageAsync(
      { type: 'batch', requests: [{ type: 'getStatus' }, { type: 'getServices' }] },
      { ...dependencies, getDatabase: throwDatabaseLocked }
    );

    expect(reply).toMatchObject({
      ok: true,
      replies: [{ ok: false, error: 'database is locked' }, { ok: true }],
    });
  });

  it('rejects a batch nested inside a batch without running it', async () => {
    const reply = await handleNativeHostMessageAsync(
      {
        type: 'batch',
        requests: [{ type: 'batch', requests: [{ type: 'getStatus' }] }, { type: 'getRunHistory' }],
      },
      makeDependencies()
    );

    expect(reply).toEqual({
      ok: true,
      replies: [
        { ok: false, error: expect.stringContaining('cannot contain another batch') },
        { ok: true, searches: [] },
      ],
    });
  });

  it.each([
    ['requests missing', undefined],
    ['requests that is not an array', { type: 'getStatus' }],
    ['no requests', []],
    [
      `more than ${MAX_BATCH_REQUEST_COUNT} requests`,
      Array.from({ length: MAX_BATCH_REQUEST_COUNT + 1 }, () => ({ type: 'getStatus' })),
    ],
  ])('rejects the whole batch for %s', async (_description, requests) => {
    const reply = await handleNativeHostMessageAsync(
      { type: 'batch', requests },
      makeDependencies()
    );

    expect(reply).toEqual({
      ok: false,
      error: `batch requires requests to be an array of 1 to ${MAX_BATCH_REQUEST_COUNT} requests`,
    });
  });

  it(`accepts exactly ${MAX_BATCH_REQUEST_COUNT} requests`, async () => {
    const reply = await handleNativeHostMessageAsync(
      {
        type: 'batch',
        requests: Array.from({ length: MAX_BATCH_REQUEST_COUNT }, () => ({
          type: 'getRunHistory',
        })),
      },
      makeDependencies()
    );

    expect(reply).toMatchObject({ ok: true, replies: expect.any(Array) });
  });
});
