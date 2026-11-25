/**
 * Installs the launchd plists for the Sifty webapp and ngrok services, so the
 * Sifty Server tab can start and stop them.
 *
 * Run with: npm run services:install
 *
 * Installing never starts anything. A service installed for the first time is
 * also disabled, so it stays off at login until it is started from the tab.
 * Re-running rewrites the plists but leaves each service's on/off state alone.
 * The existing scheduler plist is not touched.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runLaunchctlAsync } from '../src/nativeHost/runLaunchctl';
import { getCurrentUserId, getLaunchAgentsDirectory } from '../src/nativeHost/hostEnvironment';
import { buildInstallablePlistOptions, NGROK_PATH } from '../src/nativeHost/serviceDefinitions';
import { buildServicePlist } from '../src/nativeHost/servicePlist';
import { writeFileAtomically } from '../src/nativeHost/writeFileAtomically';
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
    const plistPath = path.join(LAUNCH_AGENTS_DIRECTORY, `${options.label}.plist`);
    const isFirstInstall = !fs.existsSync(plistPath);

    writeFileAtomically(plistPath, buildServicePlist(options));
    console.log(`Wrote ${plistPath}`);

    if (isFirstInstall) {
      const result = await runLaunchctlAsync(['disable', `gui/${userId}/${options.label}`]);
      if (result.exitCode !== 0) {
        throw new Error(`launchctl disable ${options.label} failed: ${result.output.trim()}`);
      }
      console.log(`Disabled ${options.label} — start it from the Sifty Server tab`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
