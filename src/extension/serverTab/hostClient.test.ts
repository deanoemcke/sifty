import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeLaunchd } from '../../nativeHost/fakeLaunchd';
import {
  handleNativeHostMessageAsync,
  type NativeHostDependencies,
} from '../../nativeHost/handleMessage';
import {
  initSchema,
  stmtInsertSavedSearch,
  stmtUpdateSavedSearchLastRunAt,
  stmtUpdateSavedSearchRunStatus,
} from '../../server/db';
import { saveFacebookCookies } from '../../server/facebookCookies';
import type { ChromeApi } from '../startCookieSync';
import { createHostClient, HostRejectedError } from './hostClient';

const WEBAPP_PLIST = '/plists/webapp.plist';
const NGROK_PLIST = '/plists/ngrok.plist';

function clientReplying(reply: unknown) {
  return createHostClient({
    runtime: { sendNativeMessage: async () => reply },
  } as unknown as Pick<ChromeApi, 'runtime'>);
}

function makeRealHost(logFilePath: string) {
  const database = new Database(':memory:');
  initSchema(database);
  const fake = makeFakeLaunchd({
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
  });
  const dependencies: NativeHostDependencies = {
    getDatabase: () => database,
    logFilePathsByLogName: { webapp: logFilePath },
    services: {
      definitionsByServiceName: {
        webapp: {
          label: 'ai.openclaw.sifty-webapp',
          plistPath: WEBAPP_PLIST,
          isIntervalJob: false,
        },
        ngrok: { label: 'ai.openclaw.sifty-ngrok', plistPath: NGROK_PLIST, isIntervalJob: true },
      },
      userId: 501,
      runLaunchctlAsync: fake.runLaunchctlAsync,
      doesFileExist: () => true,
    },
  };
  const client = createHostClient({
    runtime: {
      sendNativeMessage: (_hostName: string, message: unknown) =>
        handleNativeHostMessageAsync(message, dependencies),
    },
  } as unknown as Pick<ChromeApi, 'runtime'>);
  return { client, database };
}

describe('createHostClient against the real host handler', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeHost() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-client-'));
    temporaryDirectories.push(directory);
    const logFilePath = path.join(directory, 'webapp.log');
    fs.writeFileSync(logFilePath, 'first\nsecond\n');
    return makeRealHost(logFilePath);
  }

  it('accepts a status reply when no cookies are synced', async () => {
    const { client } = makeHost();

    await expect(client.getStatus()).resolves.toEqual({
      cookies: { isSynced: false },
      settings: { targetIntervalMinutes: 240, maxSearchesPerTick: 5 },
    });
  });

  it('accepts a status reply for a usable login', async () => {
    const { client, database } = makeHost();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1' },
        { name: 'xs', value: '2' },
      ])
    );

    const status = await client.getStatus();

    expect(status.cookies).toMatchObject({ isSynced: true, isLoginUsable: true, cookieCount: 2 });
  });

  it('accepts run history, including a search that has run and one that has not', async () => {
    const { client, database } = makeHost();
    for (const id of ['ran', 'never']) {
      stmtInsertSavedSearch(database).run(
        id,
        id,
        JSON.stringify(['https://x.test']),
        null,
        null,
        1,
        1
      );
    }
    stmtUpdateSavedSearchLastRunAt(database).run(1_699_990_000_000, 'ran');
    stmtUpdateSavedSearchRunStatus(database).run(0, 'scrape:Timed out', null, 'ran');

    const searches = await client.getRunHistory();

    expect(searches).toHaveLength(2);
    expect(searches.find((search) => search.id === 'ran')).toMatchObject({
      lastRunSucceeded: false,
      lastRunDetailLines: ['scrape:Timed out'],
    });
    expect(searches.find((search) => search.id === 'never')).toMatchObject({
      lastRunAtMs: null,
      nextDueAtMs: null,
    });
  });

  it('accepts updated settings, services and a log tail', async () => {
    const { client } = makeHost();

    await expect(
      client.updateSettings({ targetIntervalMinutes: 240, maxSearchesPerTick: 7 })
    ).resolves.toEqual({
      targetIntervalMinutes: 240,
      maxSearchesPerTick: 7,
    });
    await expect(client.getServices()).resolves.toMatchObject({
      webapp: { isLoaded: true, isRunning: true, isInstalled: true, isIntervalJob: false },
      ngrok: { isLoaded: false, isEnabled: false, isIntervalJob: true },
    });
    await expect(client.tailLog('webapp', 10)).resolves.toEqual({
      isLogFilePresent: true,
      logLines: ['first', 'second'],
    });
  });
});

const VALID_SETTINGS = { targetIntervalMinutes: 240, maxSearchesPerTick: 5 };
const VALID_SEARCH = {
  id: 'a',
  name: 'A',
  lastRunAtMs: 1,
  lastRunSucceeded: true,
  lastRunDetailLines: [],
  nextDueAtMs: 2,
};
const VALID_SERVICE = {
  isLoaded: true,
  isRunning: true,
  isEnabled: true,
  pid: 1,
  isInstalled: true,
  isIntervalJob: false,
};
const VALID_USABLE_COOKIES = {
  isSynced: true,
  syncedAtMs: 1,
  isLoginUsable: true,
  cookieCount: 3,
  loginExpiryMs: null,
};

describe('createHostClient rejecting malformed replies', () => {
  it('rejects a reply that is not an object', async () => {
    await expect(clientReplying('nope').getStatus()).rejects.toThrow(HostRejectedError);
    await expect(clientReplying(null).getStatus()).rejects.toThrow(HostRejectedError);
  });

  it('rejects a host error reply with the host message', async () => {
    await expect(clientReplying({ ok: false, error: 'locked' }).getStatus()).rejects.toThrow(
      'locked'
    );
  });

  it.each([
    ['cookies missing', { ok: true, settings: VALID_SETTINGS }, 'cookies'],
    [
      'a usable login that predates isLoginUsable',
      {
        ok: true,
        cookies: { isSynced: true, syncedAtMs: 1, cookieCount: 3, loginExpiryMs: null },
        settings: VALID_SETTINGS,
      },
      'cookies',
    ],
    [
      'a usable login with no cookieCount',
      {
        ok: true,
        cookies: { ...VALID_USABLE_COOKIES, cookieCount: undefined },
        settings: VALID_SETTINGS,
      },
      'cookies',
    ],
    [
      'an unusable login with no reason',
      {
        ok: true,
        cookies: { isSynced: true, syncedAtMs: 1, isLoginUsable: false },
        settings: VALID_SETTINGS,
      },
      'cookies',
    ],
    [
      'isSynced missing',
      { ok: true, cookies: { syncedAtMs: 1 }, settings: VALID_SETTINGS },
      'cookies',
    ],
    [
      'settings missing a setting',
      { ok: true, cookies: { isSynced: false }, settings: { targetIntervalMinutes: 240 } },
      'settings',
    ],
    [
      'settings with a non-number',
      {
        ok: true,
        cookies: { isSynced: false },
        settings: { targetIntervalMinutes: '240', maxSearchesPerTick: 5 },
      },
      'settings',
    ],
  ])('rejects a status reply with %s', async (_description, reply, fieldName) => {
    await expect(clientReplying(reply).getStatus()).rejects.toThrow(
      `Host reply has no valid "${fieldName}"`
    );
  });

  it('accepts every valid cookie status', async () => {
    for (const cookies of [
      { isSynced: false },
      VALID_USABLE_COOKIES,
      { ...VALID_USABLE_COOKIES, loginExpiryMs: 5 },
      { isSynced: true, syncedAtMs: 1, isLoginUsable: false, unusableReason: 'no xs' },
    ]) {
      const status = await clientReplying({
        ok: true,
        cookies,
        settings: VALID_SETTINGS,
      }).getStatus();
      expect(status.cookies).toEqual(cookies);
    }
  });

  it.each([
    ['searches not an array', { ok: true, searches: 'x' }],
    ['an entry with only an id', { ok: true, searches: [{ id: 'b' }] }],
    ['an entry that is not an object', { ok: true, searches: [null] }],
    [
      'a non-boolean lastRunSucceeded',
      { ok: true, searches: [{ ...VALID_SEARCH, lastRunSucceeded: 1 }] },
    ],
    [
      'detail lines that are not strings',
      { ok: true, searches: [{ ...VALID_SEARCH, lastRunDetailLines: [1] }] },
    ],
    ['a string nextDueAtMs', { ok: true, searches: [{ ...VALID_SEARCH, nextDueAtMs: '2' }] }],
  ])('rejects run history with %s', async (_description, reply) => {
    await expect(clientReplying(reply).getRunHistory()).rejects.toThrow(HostRejectedError);
  });

  it('accepts run history entries that have never run', async () => {
    const neverRun = {
      ...VALID_SEARCH,
      lastRunAtMs: null,
      lastRunSucceeded: null,
      nextDueAtMs: null,
    };

    await expect(
      clientReplying({ ok: true, searches: [neverRun] }).getRunHistory()
    ).resolves.toEqual([neverRun]);
  });

  it('rejects updateSettings replies with incomplete settings', async () => {
    await expect(
      clientReplying({ ok: true, settings: {} }).updateSettings(VALID_SETTINGS)
    ).rejects.toThrow('Host reply has no valid "settings"');
  });

  it.each([
    ['a missing servicesByName', { ok: true }],
    [
      'a service missing isInstalled',
      { ok: true, servicesByName: { webapp: { ...VALID_SERVICE, isInstalled: undefined } } },
    ],
    ['a service that is not an object', { ok: true, servicesByName: { webapp: 'running' } }],
    ['a non-numeric pid', { ok: true, servicesByName: { webapp: { ...VALID_SERVICE, pid: '1' } } }],
  ])('rejects getServices with %s', async (_description, reply) => {
    await expect(clientReplying(reply).getServices()).rejects.toThrow(HostRejectedError);
  });

  it.each([
    ['isLogFilePresent missing', { ok: true, logLines: [] }, 'isLogFilePresent'],
    ['logLines not strings', { ok: true, isLogFilePresent: true, logLines: [1] }, 'logLines'],
  ])('rejects tailLog with %s', async (_description, reply, fieldName) => {
    await expect(clientReplying(reply).tailLog('webapp', 5)).rejects.toThrow(
      `Host reply has no valid "${fieldName}"`
    );
  });
});
