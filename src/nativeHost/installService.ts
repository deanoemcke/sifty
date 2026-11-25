import fs from 'node:fs';
import path from 'node:path';
import type { CommandResult } from './controlService';
import { buildServicePlist, type ServicePlistOptions } from './servicePlist';
import { writeFileAtomically } from './writeFileAtomically';

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
