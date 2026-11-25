import fs from 'node:fs';
import path from 'node:path';
import type { CommandResult } from './controlService';
import { buildServicePlist, type ServicePlistOptions } from './servicePlist';
import { writeFileAtomically } from './writeFileAtomically';

// Writes the service's plist. A service installed for the first time is also
// disabled, so it stays off at login until it is started from the tab; an
// existing one keeps its on/off state. The disable happens before the plist is
// written: the plist's existence is what marks "installed", so a failed disable
// must leave no plist behind, or the next run would skip the disable for good.
export async function installServiceAsync(input: {
  options: ServicePlistOptions;
  plistDirectory: string;
  userId: number;
  runLaunchctlAsync: (args: string[]) => Promise<CommandResult>;
}): Promise<void> {
  const { options, plistDirectory, userId, runLaunchctlAsync } = input;
  const plistPath = path.join(plistDirectory, `${options.label}.plist`);
  const isFirstInstall = !fs.existsSync(plistPath);

  if (isFirstInstall) {
    const result = await runLaunchctlAsync(['disable', `gui/${userId}/${options.label}`]);
    if (result.exitCode !== 0) {
      throw new Error(`launchctl disable ${options.label} failed: ${result.output.trim()}`);
    }
  }

  writeFileAtomically(plistPath, buildServicePlist(options));
  console.log(`Wrote ${plistPath}`);
  if (isFirstInstall) {
    console.log(`Disabled ${options.label} — start it from the Sifty Server tab`);
  }
}
