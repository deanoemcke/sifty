import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { makeFakeLaunchd } from '../../nativeHost/fakeLaunchd';
import {
  handleNativeHostMessageAsync,
  type NativeHostDependencies,
} from '../../nativeHost/handleMessage';
import {
  isReadOnlyRequestType,
  MAX_BATCH_REQUEST_COUNT,
  NATIVE_HOST_REQUEST_TYPES,
} from '../../nativeHost/protocol';
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

function clientRecording(reply: unknown) {
  const sentMessages: unknown[] = [];
  const client = createHostClient({
    runtime: {
      sendNativeMessage: async (_hostName: string, message: unknown) => {
        sentMessages.push(message);
        return reply;
      },
    },
  } as unknown as Pick<ChromeApi, 'runtime'>);
  return { client, sentMessages };
}

function clientReplying(reply: unknown) {
  return clientRecording(reply).client;
}

function makeRealHost() {
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
    logStreams: { subscribe: () => {}, stopAll: () => {} },
    logActivity: () => {},
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
  it('fetches every panel from the real host in one request', async () => {
    const { client } = makeRealHost();

    const panels = await client.getPanels();

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
  });

  it('accepts a status for a usable login', async () => {
    const { client, database } = makeRealHost();
    saveFacebookCookies(
      database,
      JSON.stringify([
        { name: 'c_user', value: '1' },
        { name: 'xs', value: '2' },
      ])
    );

    const panels = await client.getPanels();

    expect(fulfilledValueOf(panels.status).cookies).toMatchObject({
      isSynced: true,
      isLoginUsable: true,
      cookieCount: 2,
    });
  });

  it('accepts run history, including a search that has run and one that has not', async () => {
    const { client, database } = makeRealHost();
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

    const searches = fulfilledValueOf((await client.getPanels()).runHistory);

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

  it('accepts updated settings', async () => {
    const { client } = makeRealHost();

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
};

const PANEL_NAMES = Object.keys(VALID_PANEL_REPLIES) as PanelName[];

function getPanelsWithSubReplies(subRepliesByPanelName: Partial<Record<PanelName, unknown>>) {
  const repliesByPanelName = { ...VALID_PANEL_REPLIES, ...subRepliesByPanelName };
  return clientReplying({
    ok: true,
    replies: PANEL_NAMES.map((panelName) => repliesByPanelName[panelName]),
  }).getPanels();
}

function expectEveryPanelRejectedWith(panels: ServerTabPanels, expectedError: Error): void {
  for (const panelName of PANEL_NAMES) {
    const reason = rejectionReasonOf(panels[panelName]);
    expect(reason).toBeInstanceOf(expectedError.constructor);
    expect(reason.message).toBe(expectedError.message);
  }
}

describe('createHostClient getPanels', () => {
  it('sends one batch of the three panel requests', async () => {
    const { client, sentMessages } = clientRecording({
      ok: true,
      replies: PANEL_NAMES.map((panelName) => VALID_PANEL_REPLIES[panelName]),
    });

    const panels = await client.getPanels();

    expect(sentMessages).toEqual([
      {
        type: 'batch',
        requests: [{ type: 'getServices' }, { type: 'getStatus' }, { type: 'getRunHistory' }],
      },
    ]);
    expect(panels).toEqual({
      services: { status: 'fulfilled', value: { webapp: VALID_SERVICE } },
      status: {
        status: 'fulfilled',
        value: { cookies: { isSynced: false }, settings: VALID_SETTINGS },
      },
      runHistory: { status: 'fulfilled', value: [VALID_SEARCH] },
    });
  });

  it('rejects only the panel whose sub-reply is an error, with the host message', async () => {
    const panels = await getPanelsWithSubReplies({ status: { ok: false, error: 'locked' } });

    expect(rejectionReasonOf(panels.status)).toEqual(new HostRejectedError('locked'));
    expect(panels.services.status).toBe('fulfilled');
    expect(panels.runHistory.status).toBe('fulfilled');
  });

  it('rejects only the panel whose sub-reply is malformed', async () => {
    const panels = await getPanelsWithSubReplies({ runHistory: { ok: true, searches: 'x' } });

    expect(rejectionReasonOf(panels.runHistory)).toEqual(
      new HostRejectedError('Host reply has no valid "searches"')
    );
    expect(panels.services.status).toBe('fulfilled');
    expect(panels.status.status).toBe('fulfilled');
  });

  it('rejects only the panel whose sub-reply is not an object', async () => {
    const panels = await getPanelsWithSubReplies({ services: null });

    expect(rejectionReasonOf(panels.services)).toBeInstanceOf(HostRejectedError);
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
      await client.getPanels(),
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
      'Host sent 1 replies for 3 requests',
    ],
  ])('rejects every panel with the reason for %s', async (_description, reply, message) => {
    expectEveryPanelRejectedWith(
      await clientReplying(reply).getPanels(),
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
});

function collectRequestTypes(message: unknown): unknown[] {
  const { type, requests } = message as { type: unknown; requests?: unknown[] };
  return [type, ...(requests ?? []).flatMap(collectRequestTypes)];
}

describe('createHostClient requests', () => {
  it('keeps the panels batch within the size and request types the host accepts', async () => {
    const { client, sentMessages } = clientRecording({ ok: true, replies: [] });

    await client.getPanels();

    const [batch] = sentMessages as { requests: { type: string }[] }[];
    expect(batch.requests.length).toBeLessThanOrEqual(MAX_BATCH_REQUEST_COUNT);
    expect(batch.requests.every((request) => isReadOnlyRequestType(request.type))).toBe(true);
  });

  it('sends only request types the native host protocol defines, inside a batch too', async () => {
    const { client, sentMessages } = clientRecording({ ok: true, settings: VALID_SETTINGS });

    await client.getPanels();
    await client.updateSettings(VALID_SETTINGS);
    await client.controlService('webapp', 'start');

    const sentTypes = sentMessages.flatMap(collectRequestTypes);
    expect(sentTypes).toEqual([
      'batch',
      'getServices',
      'getStatus',
      'getRunHistory',
      'updateSettings',
      'controlService',
    ]);
    expect(NATIVE_HOST_REQUEST_TYPES).toEqual(expect.arrayContaining(sentTypes));
  });
});

describe('a bug while reading one sub-reply', () => {
  it('lets a thrown TypeError surface instead of reporting it as a host error', async () => {
    const buggyReply = {
      ok: true,
      replies: [
        {
          ok: true,
          get servicesByName(): never {
            throw new TypeError('parser bug');
          },
        },
        { ok: false, error: 'x' },
        { ok: false, error: 'x' },
      ],
    };

    await expect(clientReplying(buggyReply).getPanels()).rejects.toBeInstanceOf(TypeError);
  });
});

function openLogStream() {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const postedMessages: unknown[] = [];
  let isDisconnected = false;
  const port = {
    postMessage: (message: unknown) => postedMessages.push(message),
    onMessage: {
      addListener: (listener: (message: unknown) => void) => messageListeners.push(listener),
    },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    disconnect: () => {
      isDisconnected = true;
    },
  };
  const client = createHostClient({
    runtime: { connectNative: () => port },
  } as unknown as Pick<ChromeApi, 'runtime'>);
  const logTails: { logName: string; logTail: unknown }[] = [];
  const errors: Error[] = [];
  const errorLogNames: (string | undefined)[] = [];
  const closures: Error[] = [];
  const stream = client.openLogStream(200, {
    onLogTail: (logName, logTail) => logTails.push({ logName, logTail }),
    onError: (error, logName) => {
      errors.push(error);
      errorLogNames.push(logName);
    },
    onClosed: (error) => closures.push(error),
  });
  return {
    stream,
    postedMessages,
    logTails,
    errors,
    errorLogNames,
    closures,
    isDisconnected: () => isDisconnected,
    pushFromHost: (message: unknown) => {
      for (const listener of messageListeners) listener(message);
    },
    closeFromHost: () => {
      for (const listener of disconnectListeners) listener();
    },
  };
}

describe('createHostClient openLogStream', () => {
  it('asks the host to stream the given number of lines of every log', () => {
    const { postedMessages } = openLogStream();

    expect(postedMessages).toEqual([{ type: 'subscribeLogs', lineCount: 200 }]);
  });

  it('passes on each log tail and ignores the subscription acknowledgement', () => {
    const { pushFromHost, logTails, errors } = openLogStream();

    pushFromHost({ ok: true, isSubscribed: true });
    pushFromHost({
      ok: true,
      event: 'logTail',
      logName: 'webapp',
      isLogFilePresent: true,
      logLines: ['one', 'two'],
    });

    expect(logTails).toEqual([
      { logName: 'webapp', logTail: { isLogFilePresent: true, logLines: ['one', 'two'] } },
    ]);
    expect(errors).toEqual([]);
  });

  it('reports a host error as an error and keeps the stream open', () => {
    const { pushFromHost, errors, closures } = openLogStream();

    pushFromHost({ ok: false, error: 'Could not read the webapp log: EACCES' });

    expect(errors).toEqual([new HostRejectedError('Could not read the webapp log: EACCES')]);
    expect(closures).toEqual([]);
  });

  it('says which log a host error is about when the host names one', () => {
    const { pushFromHost, errorLogNames } = openLogStream();

    pushFromHost({ ok: false, logName: 'webapp', error: 'Could not read the webapp log: EACCES' });
    pushFromHost({ ok: false, error: 'Native message is too large' });

    expect(errorLogNames).toEqual(['webapp', undefined]);
  });

  it.each([
    ['isLogFilePresent missing', { logName: 'webapp', logLines: [] }, 'isLogFilePresent'],
    [
      'logLines not strings',
      { logName: 'webapp', isLogFilePresent: true, logLines: [1] },
      'logLines',
    ],
    ['logName missing', { isLogFilePresent: true, logLines: [] }, 'logName'],
  ])('reports a log tail with %s as an error', (_description, fields, fieldName) => {
    const { pushFromHost, logTails, errors } = openLogStream();

    pushFromHost({ ok: true, event: 'logTail', ...fields });

    expect(logTails).toEqual([]);
    expect(errors).toEqual([new HostRejectedError(`Host reply has no valid "${fieldName}"`)]);
  });

  it('reports the connection closing without being asked as the host being unreachable', () => {
    const { closeFromHost, closures } = openLogStream();

    closeFromHost();

    expect(closures).toHaveLength(1);
    expect(closures[0]).toBeInstanceOf(HostUnreachableError);
  });

  it('disconnects when closed, and then reports nothing further', () => {
    const { stream, isDisconnected, pushFromHost, closeFromHost, logTails, closures } =
      openLogStream();

    stream.close();
    pushFromHost({
      ok: true,
      event: 'logTail',
      logName: 'webapp',
      isLogFilePresent: true,
      logLines: [],
    });
    closeFromHost();

    expect(isDisconnected()).toBe(true);
    expect(logTails).toEqual([]);
    expect(closures).toEqual([]);
  });
});
