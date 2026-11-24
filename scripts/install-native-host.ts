/**
 * Registers the native messaging host with Chrome so the Sifty Server
 * extension (and only that extension) can start it.
 *
 * Run with: npm run native-host:install -- {extensionId}
 * Re-run after moving the checkout: the manifest holds an absolute path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNativeHostManifest } from '../src/nativeHost/hostManifest';
import { NATIVE_HOST_NAME } from '../src/nativeHost/hostName';

const CHROME_NATIVE_HOSTS_DIRECTORY = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/NativeMessagingHosts'
);

function main(): void {
  const extensionId = process.argv[2];
  if (!extensionId) {
    console.error('Usage: npm run native-host:install -- {extensionId}');
    process.exit(2);
  }

  const manifest = buildNativeHostManifest({
    hostPath: path.resolve(__dirname, 'sifty-native-host.sh'),
    extensionId,
  });

  fs.mkdirSync(CHROME_NATIVE_HOSTS_DIRECTORY, { recursive: true });
  const manifestPath = path.join(CHROME_NATIVE_HOSTS_DIRECTORY, `${NATIVE_HOST_NAME}.json`);
  // Written to a temporary file and renamed, so Chrome never reads a half-written manifest.
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporaryPath, manifestPath);
  console.log(`Installed ${manifestPath}`);
}

main();
