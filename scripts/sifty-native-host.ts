/**
 * Chrome native messaging host for the Sifty Server extension. Chrome starts
 * it (via sifty-native-host.sh) for each request; it answers on stdout and
 * exits when Chrome closes stdin. All the logic lives in src/nativeHost.
 */

import { LOG_FILE_PATHS_BY_LOG_NAME } from '../src/nativeHost/logFiles';
import { runLaunchctlAsync } from '../src/nativeHost/runLaunchctl';
import { runNativeHostAsync } from '../src/nativeHost/runNativeHost';
import { buildServiceDefinitions } from '../src/nativeHost/serviceDefinitions';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../src/server/db';

async function main(): Promise<number> {
  // stdout carries only framed replies — a stray console.log (getDb prints
  // database stats) would corrupt the protocol, so logging goes to stderr,
  // which the wrapper script appends to the host's log file.
  console.log = (...logArguments: unknown[]) => console.error(...logArguments);

  const outcome = await runNativeHostAsync(process.stdin, process.stdout, {
    database: getDb(),
    logFilePathsByLogName: LOG_FILE_PATHS_BY_LOG_NAME,
    services: {
      definitionsByServiceName: buildServiceDefinitions(
        path.join(os.homedir(), 'Library/LaunchAgents')
      ),
      userId: process.getuid?.() ?? 501,
      runLaunchctlAsync,
      doesFileExist: (filePath) => fs.existsSync(filePath),
    },
  });
  if (outcome === 'protocol-error') {
    console.error('[native-host] stopped after a malformed or oversized message');
    return 1;
  }
  return 0;
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    console.error('[native-host] fatal:', error);
    process.exitCode = 1;
  }
);
