import type { CommandResult } from './controlService';

export type FakeServiceState = {
  plistPath: string;
  isLoaded: boolean;
  isEnabled: boolean;
  pid: number | null;
};

export function makeFakeLaunchd(
  initialStatesByLabel: Record<string, FakeServiceState>,
  failuresBySubcommand: Record<string, string> = {}
) {
  const statesByLabel: Record<string, FakeServiceState> = {};
  for (const [label, state] of Object.entries(initialStatesByLabel)) {
    statesByLabel[label] = { ...state };
  }
  let nextPid = 9000;
  const commands: string[][] = [];

  function requireState(label: string): FakeServiceState | undefined {
    return statesByLabel[label];
  }

  function labelFromTarget(target: string): string {
    return target.split('/').pop() ?? '';
  }

  async function runLaunchctlAsync(args: string[]): Promise<CommandResult> {
    commands.push(args);
    const [subcommand, firstArgument, secondArgument] = args;
    const failure = failuresBySubcommand[subcommand];
    if (failure) return { exitCode: 1, output: failure };

    switch (subcommand) {
      case 'list': {
        const state = requireState(firstArgument);
        if (!state?.isLoaded) {
          return { exitCode: 113, output: `Could not find service "${firstArgument}"` };
        }
        const pidLine = state.pid === null ? '' : `\t"PID" = ${state.pid};\n`;
        return { exitCode: 0, output: `{\n\t"Label" = "${firstArgument}";\n${pidLine}};\n` };
      }
      case 'print-disabled': {
        const lines = Object.entries(statesByLabel).map(
          ([label, state]) => `\t\t"${label}" => ${state.isEnabled ? 'enabled' : 'disabled'}`
        );
        return {
          exitCode: 0,
          output: `\n\tdisabled services = {\n${lines.join('\n')}\n\t}\n`,
        };
      }
      case 'enable':
      case 'disable': {
        const state = requireState(labelFromTarget(firstArgument));
        if (!state) return { exitCode: 113, output: 'Could not find service' };
        state.isEnabled = subcommand === 'enable';
        return { exitCode: 0, output: '' };
      }
      case 'bootstrap': {
        const entry = Object.entries(statesByLabel).find(
          ([, state]) => state.plistPath === secondArgument
        );
        if (!entry) return { exitCode: 5, output: 'Bootstrap failed: 5: Input/output error' };
        const [, state] = entry;
        if (state.isLoaded || !state.isEnabled) {
          return { exitCode: 5, output: 'Bootstrap failed: 5: Input/output error' };
        }
        state.isLoaded = true;
        state.pid = nextPid++;
        return { exitCode: 0, output: '' };
      }
      case 'bootout': {
        const state = requireState(labelFromTarget(firstArgument));
        if (!state?.isLoaded) return { exitCode: 3, output: 'Boot-out failed: 3: No such process' };
        state.isLoaded = false;
        state.pid = null;
        return { exitCode: 0, output: '' };
      }
      case 'kickstart': {
        const target = firstArgument === '-k' ? secondArgument : firstArgument;
        const state = requireState(labelFromTarget(target));
        if (!state?.isLoaded) return { exitCode: 113, output: 'Could not find service' };
        state.pid = nextPid++;
        return { exitCode: 0, output: '' };
      }
      default:
        return { exitCode: 64, output: `unexpected launchctl subcommand: ${subcommand}` };
    }
  }

  return { statesByLabel, commands, runLaunchctlAsync };
}
