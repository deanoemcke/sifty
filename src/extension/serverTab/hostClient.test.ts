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
import { NATIVE_HOST_REQUEST_TYPES } from '../../nativeHost/protocol';
import {
  initSchema,
  stmtInsertSavedSearch,
  stmtUpdateSavedSearchLastRunAt,
  stmtUpdateSavedSearchRunStatus,
} from '../../server/db';
import { saveFacebookCookies } from '../../server/facebookCookies';
import type { ChromeApi } from '../startCookieSync';
import {
  createHostClient,
  HostRejectedError,
  HostUnreachableError,
  type PanelResult,
  type ServerTabPanels,
} from './hostClient';

type PanelName = keyof ServerTabPanels;

function rejectionReasonOf(result: PanelResult<unknown>): Error {
  if (result.status === 'fulfilled') throw new Error('Expected the panel to be rejected');
  return result.reason;
}

function fulfilledValueOf<Value>(result: PanelResult<Value>): Value {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

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

  it('fetches every panel from the real host in one request', async () => {
    const { client } = makeHost();

    const panels = await client.getPanels('webapp', 10);

    expect(panels.status).toEqual({
      status: 'fulfilled',
      value: {
        cookies: { isSynced: false },
        settings: { targetIntervalMinutes: 240, maxSearchesPerTick: 5 },
      },
    });
    expect(fulfilledValueOf(panels.services)).toMatchObject({
      webapp: { isLoaded: true, isRunning: true, isInstalled: true, isIntervalJob: false },
      ngrok: { isLoaded: false, isEnabled: false, isIntervalJob: true },
    });
    expect(panels.runHistory).toEqual({ status: 'fulfilled', value: [] });
    expect(panels.logTail).toEqual({
      status: 'fulfilled',
      value: { isLogFilePresent: true, logLines: ['first', 'second'] },
    });
  });

  it('accepts a status for a usable login', async () => {
    const { client, database } = makeHost();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1' },
        { name: 'xs', value: '2' },
      ])
    );

    const panels = await client.getPanels('webapp', 10);

    expect(fulfilledValueOf(panels.status).cookies).toMatchObject({
      isSynced: true,
      isLoginUsable: true,
      cookieCount: 2,
    });
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

    const searches = fulfilledValueOf((await client.getPanels('webapp', 10)).runHistory);

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

  it('keeps the other panels when the host cannot read one of them', async () => {
    const { client } = makeHost();

    const panels = await client.getPanels('formatDisk', 10);

    expect(rejectionReasonOf(panels.logTail)).toEqual(
      new HostRejectedError('Unknown log: formatDisk')
    );
    expect(panels.services.status).toBe('fulfilled');
    expect(panels.status.status).toBe('fulfilled');
    expect(panels.runHistory.status).toBe('fulfilled');
  });

  it('accepts updated settings', async () => {
    const { client } = makeHost();

    await expect(
      client.updateSettings({ targetIntervalMinutes: 240, maxSearchesPerTick: 7 })
    ).resolves.toEqual({
      targetIntervalMinutes: 240,
      maxSearchesPerTick: 7,
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

const VALID_PANEL_REPLIES: Record<PanelName, unknown> = {
  services: { ok: true, servicesByName: { webapp: VALID_SERVICE } },
  status: { ok: true, cookies: { isSynced: false }, settings: VALID_SETTINGS },
  runHistory: { ok: true, searches: [VALID_SEARCH] },
  logTail: { ok: true, isLogFilePresent: true, logLines: [] },
};

function getPanelsWithSubReplies(subRepliesByPanelName: Partial<Record<PanelName, unknown>>) {
  const repliesByPanelName = { ...VALID_PANEL_REPLIES, ...subRepliesByPanelName };
  return clientReplying({
    ok: true,
    replies: [
      repliesByPanelName.services,
      repliesByPanelName.status,
      repliesByPanelName.runHistory,
      repliesByPanelName.logTail,
    ],
  }).getPanels('webapp', 5);
}

const PANEL_NAMES = Object.keys(VALID_PANEL_REPLIES) as PanelName[];

function expectEveryPanelRejectedWith(panels: ServerTabPanels, expectedError: Error): void {
  for (const panelName of PANEL_NAMES) {
    const reason = rejectionReasonOf(panels[panelName]);
    expect(reason).toBeInstanceOf(expectedError.constructor);
    expect(reason.message).toBe(expectedError.message);
  }
}

describe('createHostClient getPanels', () => {
  it('sends one batch of the four panel requests', async () => {
    const sentMessages: unknown[] = [];
    const client = createHostClient({
      runtime: {
        sendNativeMessage: async (_hostName: string, message: unknown) => {
          sentMessages.push(message);
          return {
            ok: true,
            replies: PANEL_NAMES.map((panelName) => VALID_PANEL_REPLIES[panelName]),
          };
        },
      },
    } as unknown as Pick<ChromeApi, 'runtime'>);

    const panels = await client.getPanels('scheduler', 200);

    expect(sentMessages).toEqual([
      {
        type: 'batch',
        requests: [
          { type: 'getServices' },
          { type: 'getStatus' },
          { type: 'getRunHistory' },
          { type: 'tailLog', logName: 'scheduler', lineCount: 200 },
        ],
      },
    ]);
    expect(panels).toEqual({
      services: { status: 'fulfilled', value: { webapp: VALID_SERVICE } },
      status: {
        status: 'fulfilled',
        value: { cookies: { isSynced: false }, settings: VALID_SETTINGS },
      },
      runHistory: { status: 'fulfilled', value: [VALID_SEARCH] },
      logTail: { status: 'fulfilled', value: { isLogFilePresent: true, logLines: [] } },
    });
  });

  it('rejects only the panel whose sub-reply is an error, with the host message', async () => {
    const panels = await getPanelsWithSubReplies({ status: { ok: false, error: 'locked' } });

    expect(rejectionReasonOf(panels.status)).toEqual(new HostRejectedError('locked'));
    expect(panels.services.status).toBe('fulfilled');
    expect(panels.runHistory.status).toBe('fulfilled');
    expect(panels.logTail.status).toBe('fulfilled');
  });

  it('rejects only the panel whose sub-reply is malformed', async () => {
    const panels = await getPanelsWithSubReplies({ runHistory: { ok: true, searches: 'x' } });

    expect(rejectionReasonOf(panels.runHistory)).toEqual(
      new HostRejectedError('Host reply has no valid "searches"')
    );
    expect(panels.services.status).toBe('fulfilled');
    expect(panels.status.status).toBe('fulfilled');
    expect(panels.logTail.status).toBe('fulfilled');
  });

  it('rejects only the panel whose sub-reply is not an object', async () => {
    const panels = await getPanelsWithSubReplies({ services: null });

    expect(rejectionReasonOf(panels.services)).toBeInstanceOf(HostRejectedError);
    expect(panels.logTail.status).toBe('fulfilled');
  });

  it('rejects every panel with the reason when the host cannot be reached', async () => {
    const client = createHostClient({
      runtime: {
        sendNativeMessage: async () => {
          throw new Error('Specified native messaging host not found.');
        },
      },
    } as unknown as Pick<ChromeApi, 'runtime'>);

    expectEveryPanelRejectedWith(
      await client.getPanels('webapp', 5),
      new HostUnreachableError('Specified native messaging host not found.')
    );
  });

  it.each([
    ['a reply that is not an object', 'nope', 'Host sent a reply that is not an object'],
    ['a null reply', null, 'Host sent a reply that is not an object'],
    ['a whole-batch error', { ok: false, error: 'locked' }, 'locked'],
    ['no replies field', { ok: true }, 'Host reply has no valid "replies"'],
    [
      'the wrong number of replies',
      { ok: true, replies: [VALID_PANEL_REPLIES.services] },
      'Host sent 1 replies for 4 requests',
    ],
  ])('rejects every panel with the reason for %s', async (_description, reply, message) => {
    expectEveryPanelRejectedWith(
      await clientReplying(reply).getPanels('webapp', 5),
      new HostRejectedError(message)
    );
  });
});

describe('createHostClient rejecting malformed sub-replies', () => {
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
  ])('rejects a status with %s', async (_description, reply, fieldName) => {
    const panels = await getPanelsWithSubReplies({ status: reply });

    expect(rejectionReasonOf(panels.status)).toEqual(
      new HostRejectedError(`Host reply has no valid "${fieldName}"`)
    );
  });

  it('accepts every valid cookie status', async () => {
    for (const cookies of [
      { isSynced: false },
      VALID_USABLE_COOKIES,
      { ...VALID_USABLE_COOKIES, loginExpiryMs: 5 },
      { isSynced: true, syncedAtMs: 1, isLoginUsable: false, unusableReason: 'no xs' },
    ]) {
      const panels = await getPanelsWithSubReplies({
        status: { ok: true, cookies, settings: VALID_SETTINGS },
      });
      expect(fulfilledValueOf(panels.status).cookies).toEqual(cookies);
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
    const panels = await getPanelsWithSubReplies({ runHistory: reply });

    expect(rejectionReasonOf(panels.runHistory)).toBeInstanceOf(HostRejectedError);
  });

  it('accepts run history entries that have never run', async () => {
    const neverRun = {
      ...VALID_SEARCH,
      lastRunAtMs: null,
      lastRunSucceeded: null,
      nextDueAtMs: null,
    };

    const panels = await getPanelsWithSubReplies({
      runHistory: { ok: true, searches: [neverRun] },
    });

    expect(panels.runHistory).toEqual({ status: 'fulfilled', value: [neverRun] });
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
  ])('rejects services with %s', async (_description, reply) => {
    const panels = await getPanelsWithSubReplies({ services: reply });

    expect(rejectionReasonOf(panels.services)).toBeInstanceOf(HostRejectedError);
  });

  it.each([
    ['isLogFilePresent missing', { ok: true, logLines: [] }, 'isLogFilePresent'],
    ['logLines not strings', { ok: true, isLogFilePresent: true, logLines: [1] }, 'logLines'],
  ])('rejects a log tail with %s', async (_description, reply, fieldName) => {
    const panels = await getPanelsWithSubReplies({ logTail: reply });

    expect(rejectionReasonOf(panels.logTail)).toEqual(
      new HostRejectedError(`Host reply has no valid "${fieldName}"`)
    );
  });
});

function collectRequestTypes(message: unknown): unknown[] {
  const { type, requests } = message as { type: unknown; requests?: unknown[] };
  return [type, ...(requests ?? []).flatMap(collectRequestTypes)];
}

describe('createHostClient requests', () => {
  it('sends only request types the native host protocol defines, inside a batch too', async () => {
    const sentMessages: unknown[] = [];
    const client = createHostClient({
      runtime: {
        sendNativeMessage: async (_hostName: string, message: unknown) => {
          sentMessages.push(message);
          return { ok: true, settings: VALID_SETTINGS };
        },
      },
    } as unknown as Pick<ChromeApi, 'runtime'>);

    await client.getPanels('webapp', 5);
    await client.updateSettings(VALID_SETTINGS);
    await client.controlService('webapp', 'start');

    const sentTypes = sentMessages.flatMap(collectRequestTypes);
    expect(sentTypes).toHaveLength(7);
    expect(NATIVE_HOST_REQUEST_TYPES).toEqual(expect.arrayContaining(sentTypes));
  });
});
