// Starts, stops and restarts a launchd user service. The state it leaves behind
// persists: Stop also disables the service so it stays off after a login, and
// Start enables it so it comes back. That is how the scheduler is already
// parked on this machine.

import { parseServiceState, type ServiceState } from './serviceState';

export type CommandResult = { exitCode: number; output: string };
export type RunLaunchctl = (args: string[]) => Promise<CommandResult>;

export type ServiceDefinition = {
  label: string;
  plistPath: string;
  // A StartInterval job: launchd loads it and runs it on a timer, so it sits
  // idle with no process between ticks. Loaded and idle is its healthy state.
  isIntervalJob: boolean;
};
export const SERVICE_ACTIONS = ['start', 'stop', 'restart'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

type ServiceContext = {
  definition: ServiceDefinition;
  userId: number;
  runLaunchctlAsync: RunLaunchctl;
};

async function runCheckedAsync(context: ServiceContext, args: string[]): Promise<CommandResult> {
  const result = await context.runLaunchctlAsync(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `launchctl ${args.join(' ')} failed (exit ${result.exitCode}): ${result.output.trim()}`
    );
  }
  return result;
}

export async function getServiceStateAsync(context: ServiceContext): Promise<ServiceState> {
  const { definition, userId, runLaunchctlAsync } = context;
  const [list, printDisabled] = await Promise.all([
    runLaunchctlAsync(['list', definition.label]),
    runCheckedAsync(context, ['print-disabled', `gui/${userId}`]),
  ]);

  return parseServiceState({
    label: definition.label,
    listExitCode: list.exitCode,
    listOutput: list.output,
    printDisabledOutput: printDisabled.output,
  });
}

async function startAsync(context: ServiceContext): Promise<void> {
  const { definition, userId } = context;
  const state = await getServiceStateAsync(context);
  await runCheckedAsync(context, ['enable', `gui/${userId}/${definition.label}`]);

  if (!state.isLoaded) {
    await runCheckedAsync(context, ['bootstrap', `gui/${userId}`, definition.plistPath]);
  } else if (!state.isRunning && !definition.isIntervalJob) {
    await runCheckedAsync(context, ['kickstart', `gui/${userId}/${definition.label}`]);
  }
}

async function stopAsync(context: ServiceContext): Promise<void> {
  const { definition, userId } = context;
  const state = await getServiceStateAsync(context);

  if (state.isLoaded) {
    await runCheckedAsync(context, ['bootout', `gui/${userId}/${definition.label}`]);
  }
  await runCheckedAsync(context, ['disable', `gui/${userId}/${definition.label}`]);
}

async function restartAsync(context: ServiceContext): Promise<void> {
  const { definition, userId } = context;
  const state = await getServiceStateAsync(context);

  if (!state.isLoaded) {
    await startAsync(context);
    return;
  }
  await runCheckedAsync(context, ['kickstart', '-k', `gui/${userId}/${definition.label}`]);
}

// Returns the state after the action. The first failing launchctl step throws
// with launchctl's own message, and nothing after it runs.
export async function controlServiceAsync(
  context: ServiceContext & { action: ServiceAction }
): Promise<ServiceState> {
  switch (context.action) {
    case 'start':
      await startAsync(context);
      break;
    case 'stop':
      await stopAsync(context);
      break;
    case 'restart':
      await restartAsync(context);
      break;
  }
  return getServiceStateAsync(context);
}
