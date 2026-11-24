// Builds the manifest Chrome reads to find the native host — see
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

import path from 'node:path';

export const NATIVE_HOST_NAME = 'com.sifty.server';

// Chrome extension IDs are 32 characters from a–p (a hex-style encoding).
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export type NativeHostManifest = {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
};

// allowed_origins is the only access control on the host: Chrome refuses calls
// from any other extension. A wildcard is not valid there, and the ID is
// validated so a typo can't silently produce a manifest nothing may use.
export function buildNativeHostManifest(options: {
  hostPath: string;
  extensionId: string;
}): NativeHostManifest {
  if (!EXTENSION_ID_PATTERN.test(options.extensionId)) {
    throw new Error(
      `Invalid extension ID "${options.extensionId}": expected 32 lowercase letters from a to p`
    );
  }
  if (!path.isAbsolute(options.hostPath)) {
    throw new Error(`Host path must be absolute, got "${options.hostPath}"`);
  }

  return {
    name: NATIVE_HOST_NAME,
    description: 'Sifty Server native host',
    path: options.hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  };
}
