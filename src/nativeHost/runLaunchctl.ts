import { execFile } from 'node:child_process';
import type { CommandResult } from './controlService';

const LAUNCHCTL_PATH = '/bin/launchctl';
// Resource limits on an external process: it must answer quickly, briefly.
const LAUNCHCTL_TIMEOUT_MS = 10_000;
const LAUNCHCTL_MAX_OUTPUT_BYTES = 1024 * 1024;

// Resolves with launchctl's exit code and output — a non-zero exit is data for
// the caller to interpret (113 means "not loaded"). A launchctl that cannot be
// started, times out or floods its output rejects instead, so it is never
// mistaken for "the service is stopped".
export function runLaunchctlAsync(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      LAUNCHCTL_PATH,
      args,
      { timeout: LAUNCHCTL_TIMEOUT_MS, maxBuffer: LAUNCHCTL_MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (!error) {
          resolve({ exitCode: 0, output });
        } else if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, output });
        } else {
          reject(new Error(`launchctl ${args.join(' ')} could not run: ${error.message}`));
        }
      }
    );
  });
}
