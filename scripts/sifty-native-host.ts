import { getCurrentUserId, getLaunchAgentsDirectory } from '../src/nativeHost/hostEnvironment';
import { LOG_FILE_PATHS_BY_LOG_NAME } from '../src/nativeHost/logFiles';
import { runLaunchctlAsync } from '../src/nativeHost/runLaunchctl';
import { runNativeHostAsync } from '../src/nativeHost/runNativeHost';
import { buildServiceDefinitions } from '../src/nativeHost/serviceDefinitions';
import fs from 'node:fs';
import { getDb } from '../src/server/db';

function redirectConsoleLogToStderr(): void {
  console.log = (...logArguments: unknown[]) => console.error(...logArguments);
}

async function main(): Promise<number> {
  redirectConsoleLogToStderr();

  const outcome = await runNativeHostAsync(process.stdin, process.stdout, {
    getDatabase: getDb,
    logFilePathsByLogName: LOG_FILE_PATHS_BY_LOG_NAME,
    services: {
      definitionsByServiceName: buildServiceDefinitions(getLaunchAgentsDirectory()),
      userId: getCurrentUserId(),
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
