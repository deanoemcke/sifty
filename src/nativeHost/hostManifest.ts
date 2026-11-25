// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

import path from 'node:path';
import { NATIVE_HOST_NAME } from './hostName';

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export type NativeHostManifest = {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
};

// Chrome rejects a wildcard in allowed_origins.
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
