// The launchd services the Sifty Server tab controls: one place for their
// names, labels and logs, shared by the native host, the installer and the tab.

import type { ServiceDefinition } from './controlService';
import { NGROK_LOG_FILE_PATH, WEBAPP_LOG_FILE_PATH } from './logFiles';
import type { ServicePlistOptions } from './servicePlist';

export const SERVICE_NAMES = ['webapp', 'ngrok', 'scheduler'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

const SERVICE_LABELS_BY_NAME: Record<ServiceName, string> = {
  webapp: 'ai.openclaw.sifty-webapp',
  ngrok: 'ai.openclaw.sifty-ngrok',
  // Already installed (and parked disabled) on this machine; never rewritten here.
  scheduler: 'ai.openclaw.sifty-scheduler',
};

// launchd runs these on a timer (StartInterval), so they idle between ticks.
const INTERVAL_JOB_SERVICE_NAMES: readonly ServiceName[] = ['scheduler'];

export const NGROK_PATH = '/opt/homebrew/bin/ngrok';

export function buildServiceDefinitions(
  launchAgentsDirectory: string
): Record<ServiceName, ServiceDefinition> {
  return Object.fromEntries(
    SERVICE_NAMES.map((serviceName) => {
      const label = SERVICE_LABELS_BY_NAME[serviceName];
      return [
        serviceName,
        {
          label,
          plistPath: `${launchAgentsDirectory}/${label}.plist`,
          isIntervalJob: INTERVAL_JOB_SERVICE_NAMES.includes(serviceName),
        },
      ];
    })
  ) as Record<ServiceName, ServiceDefinition>;
}

// Only the webapp and ngrok are installed by this code: the scheduler's plist
// and wrapper already exist outside this repo.
type InstallableServiceName = Exclude<ServiceName, 'scheduler'>;

// What to tell someone whose service has no plist. Advice for a service the
// installer cannot write would send them to a command that does nothing.
export function describeHowToInstallService(serviceName: string): string {
  if (serviceName === 'scheduler') {
    return 'Its plist is set up outside this project, so the installer cannot create it.';
  }
  return 'Run npm run services:install in the sifty-webapp folder.';
}

export function buildInstallablePlistOptions(
  projectDirectory: string,
  devServerPort: number
): Record<InstallableServiceName, ServicePlistOptions> {
  return {
    webapp: {
      label: SERVICE_LABELS_BY_NAME.webapp,
      programArguments: ['/bin/bash', `${projectDirectory}/scripts/sifty-webapp-service.sh`],
      workingDirectory: projectDirectory,
      logFilePath: WEBAPP_LOG_FILE_PATH,
    },
    ngrok: {
      label: SERVICE_LABELS_BY_NAME.ngrok,
      // --log stdout stops ngrok drawing its terminal UI, which has no terminal under launchd.
      programArguments: [NGROK_PATH, 'http', String(devServerPort), '--log', 'stdout'],
      workingDirectory: projectDirectory,
      logFilePath: NGROK_LOG_FILE_PATH,
    },
  };
}
