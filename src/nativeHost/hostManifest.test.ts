import { describe, expect, it } from 'vitest';
import { buildNativeHostManifest } from './hostManifest';
import { NATIVE_HOST_NAME } from './hostName';

const VALID_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

describe('buildNativeHostManifest', () => {
  it('describes a stdio host that only the given extension may call', () => {
    const manifest = buildNativeHostManifest({
      hostPath: '/Users/someone/sifty/scripts/sifty-native-host.sh',
      extensionId: VALID_EXTENSION_ID,
    });

    expect(manifest).toEqual({
      name: NATIVE_HOST_NAME,
      description: 'Sifty Server native host',
      path: '/Users/someone/sifty/scripts/sifty-native-host.sh',
      type: 'stdio',
      allowed_origins: [`chrome-extension://${VALID_EXTENSION_ID}/`],
    });
  });

  it.each([
    ['too short', 'abcdefghijklmnop'],
    ['too long', `${VALID_EXTENSION_ID}a`],
    ['upper case', 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP'],
    ['outside the a-p alphabet', 'qrstuvwxyzqrstuvwxyzqrstuvwxyzqr'],
    ['a wildcard', '*'],
    ['a full origin', `chrome-extension://${VALID_EXTENSION_ID}/`],
    ['empty', ''],
  ])('rejects an extension ID that is %s', (_description, extensionId) => {
    expect(() => buildNativeHostManifest({ hostPath: '/host.sh', extensionId })).toThrow(
      /extension ID/
    );
  });

  it('rejects a relative host path, which Chrome would not resolve', () => {
    expect(() =>
      buildNativeHostManifest({ hostPath: 'scripts/host.sh', extensionId: VALID_EXTENSION_ID })
    ).toThrow(/absolute/);
  });
});
