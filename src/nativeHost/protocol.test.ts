import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../server/db';
import { handleNativeHostMessageAsync, type NativeHostDependencies } from './handleMessage';
import {
  buildNativeHostRequest,
  NATIVE_HOST_REQUEST_TYPES,
  type ReadOnlyRequest,
} from './protocol';

function makeDependencies(): NativeHostDependencies {
  const database = new Database(':memory:');
  initSchema(database);
  return {
    getDatabase: () => database,
    logStreams: { subscribe: () => {}, stopAll: () => {} },
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

    const errorMessage = reply.ok ? '' : reply.error;
    expect(errorMessage).not.toMatch(/Unknown request type|Unhandled request type/);
  });

  it('leaves the host rejecting a type it does not list', async () => {
    const reply = await handleNativeHostMessageAsync({ type: 'getSettings' }, makeDependencies());

    expect(reply).toEqual({ ok: false, error: 'Unknown request type: getSettings' });
  });

  it.each([
    'constructor',
    '__proto__',
    'toString',
  ])('rejects the inherited object property name %s as a request type', async (inheritedPropertyName) => {
    const reply = await handleNativeHostMessageAsync(
      { type: inheritedPropertyName },
      makeDependencies()
    );

    expect(reply).toEqual({
      ok: false,
      error: `Unknown request type: ${inheritedPropertyName}`,
    });
  });

  it('builds a request carrying its type and fields', () => {
    expect(buildNativeHostRequest('subscribeLogs', { lineCount: 20 })).toEqual({
      type: 'subscribeLogs',
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

    const readOnlyRequests: ReadOnlyRequest[] = [];

    // @ts-expect-error
    readOnlyRequests.push(stopRequest);
    // @ts-expect-error
    readOnlyRequests.push(nestedBatch);
    // @ts-expect-error
    readOnlyRequests.push({ type: 'subscribeLogs', lineCount: 200 });

    expect(readOnlyRequests).toHaveLength(3);
  });
});
