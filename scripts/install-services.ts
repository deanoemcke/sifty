import fs from 'node:fs';
import path from 'node:path';
import { installServiceAsync } from '../src/nativeHost/installService';
import { runLaunchctlAsync } from '../src/nativeHost/runLaunchctl';
import { getCurrentUserId, getLaunchAgentsDirectory } from '../src/nativeHost/hostEnvironment';
import { buildInstallablePlistOptions, NGROK_PATH } from '../src/nativeHost/serviceDefinitions';
import { getWorktreePort } from '../vite.config.helpers';

const LAUNCH_AGENTS_DIRECTORY = getLaunchAgentsDirectory();

async function main(): Promise<void> {
  const projectDirectory = path.resolve(__dirname, '..');
  const userId = getCurrentUserId();

  for (const requiredFile of [
    NGROK_PATH,
    path.join(projectDirectory, 'node_modules/.bin/vite'),
    path.join(projectDirectory, 'scripts/sifty-webapp-service.sh'),
  ]) {
    if (!fs.existsSync(requiredFile)) throw new Error(`Missing ${requiredFile}`);
  }

  fs.mkdirSync(LAUNCH_AGENTS_DIRECTORY, { recursive: true });
  const optionsByServiceName = buildInstallablePlistOptions(
    projectDirectory,
    getWorktreePort(projectDirectory)
  );

  for (const options of Object.values(optionsByServiceName)) {
    await installServiceAsync({
      options,
      plistDirectory: LAUNCH_AGENTS_DIRECTORY,
      userId,
      runLaunchctlAsync,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
