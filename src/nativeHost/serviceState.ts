export type ServiceState = {
  isLoaded: boolean;
  isRunning: boolean;
  isEnabled: boolean;
  pid: number | null;
};

const LAUNCHCTL_EXIT_NOT_LOADED = 113;

const PID_PATTERN = /"PID" = (\d+);/;

function readEnabledFlag(printDisabledOutput: string, label: string): boolean {
  // Lines look like:  "ai.openclaw.sifty-scheduler" => disabled
  for (const line of printDisabledOutput.split('\n')) {
    const match = /^\s*"([^"]+)" => (.*?)\s*$/.exec(line);
    if (match?.[1] !== label) continue;
    if (match[2] === 'enabled') return true;
    if (match[2] === 'disabled') return false;
    throw new Error(
      `launchctl print-disabled lists ${label} as "${match[2]}", expected enabled or disabled`
    );
  }
  // Not listed means launchd's default, which is enabled.
  return true;
}

export function parseServiceState(input: {
  label: string;
  listExitCode: number;
  listOutput: string;
  printDisabledOutput: string;
}): ServiceState {
  const isEnabled = readEnabledFlag(input.printDisabledOutput, input.label);

  if (input.listExitCode === LAUNCHCTL_EXIT_NOT_LOADED) {
    return { isLoaded: false, isRunning: false, isEnabled, pid: null };
  }
  if (input.listExitCode !== 0) {
    throw new Error(
      `launchctl list ${input.label} failed with exit code ${input.listExitCode}: ${input.listOutput.trim()}`
    );
  }

  const pidMatch = PID_PATTERN.exec(input.listOutput);
  const pid = pidMatch ? Number(pidMatch[1]) : null;
  return { isLoaded: true, isRunning: pid !== null, isEnabled, pid };
}
