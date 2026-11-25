import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../server/db';
import { handleNativeHostMessageAsync, type NativeHostDependencies } from './handleMessage';
import {
  type BatchableRequest,
  buildNativeHostRequest,
  NATIVE_HOST_REQUEST_TYPES,
} from './protocol';

function makeDependencies(): NativeHostDependencies {
  const database = new Database(':memory:');
  initSchema(database);
  return {
    getDatabase: () => database,
    logFilePathsByLogName: {},
    services: {
      definitionsByServiceName: {},
      userId: 501,
      runLaunchctlAsync: async () => ({ exitCode: 1, output: 'not available in this test' }),
      doesFileExist: () => true,
    },
  };
}

describe('native host protocol', () => {
  it('lists at least one request type, so the checks below cannot pass vacuously', () => {
    expect(NATIVE_HOST_REQUEST_TYPES.length).toBeGreaterThan(0);
  });

  it.each(NATIVE_HOST_REQUEST_TYPES)('is understood by the host for %s', async (requestType) => {
    const reply = await handleNativeHostMessageAsync({ type: requestType }, makeDependencies());

    expect(reply).not.toEqual({ ok: false, error: `Unknown request type: ${requestType}` });
  });

  it('leaves the host rejecting a type it does not list', async () => {
    const reply = await handleNativeHostMessageAsync({ type: 'getSettings' }, makeDependencies());

    expect(reply).toEqual({ ok: false, error: 'Unknown request type: getSettings' });
  });

  it('builds a request carrying its type and fields', () => {
    expect(buildNativeHostRequest('tailLog', { logName: 'webapp', lineCount: 20 })).toEqual({
      type: 'tailLog',
      logName: 'webapp',
      lineCount: 20,
    });
  });

  it('refuses at compile time a request type or field the protocol does not define', () => {
    // @ts-expect-error
    expect(buildNativeHostRequest('getSettings', {})).toEqual({ type: 'getSettings' });
    // @ts-expect-error
    expect(buildNativeHostRequest('syncCookies', { cookieJson: '[]' })).toBeDefined();
  });

  it('refuses at compile time a batch holding a state-changing request or another batch', () => {
    const stopRequest = buildNativeHostRequest('controlService', {
      serviceName: 'webapp',
      action: 'stop',
    });
    const nestedBatch = buildNativeHostRequest('batch', { requests: [] });

    const batchableRequests: BatchableRequest[] = [];

    // @ts-expect-error
    batchableRequests.push(stopRequest);
    // @ts-expect-error
    batchableRequests.push(nestedBatch);
    // @ts-expect-error
    batchableRequests.push({ type: 'tailLog' });

    expect(batchableRequests).toHaveLength(3);
  });
});
