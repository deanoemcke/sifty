import { describe, expect, it } from 'vitest';
import { LOG_FILE_PATHS_BY_LOG_NAME } from './logFiles';
import {
  buildInstallablePlistOptions,
  buildServiceDefinitions,
  describeHowToInstallService,
  SERVICE_NAMES,
} from './serviceDefinitions';

const PROJECT_DIRECTORY = '/Users/someone/sifty';
const LAUNCH_AGENTS_DIRECTORY = '/Users/someone/Library/LaunchAgents';
const DEV_SERVER_PORT = 5173;

describe('buildServiceDefinitions', () => {
  it('names a launchd label and a plist in the LaunchAgents folder for every service', () => {
    const definitions = buildServiceDefinitions(LAUNCH_AGENTS_DIRECTORY);

    expect(Object.keys(definitions).sort()).toEqual([...SERVICE_NAMES].sort());
    for (const definition of Object.values(definitions)) {
      expect(definition.plistPath).toBe(`${LAUNCH_AGENTS_DIRECTORY}/${definition.label}.plist`);
    }
  });

  it('points the scheduler at the existing plist, which this code never rewrites', () => {
    expect(buildServiceDefinitions(LAUNCH_AGENTS_DIRECTORY).scheduler).toEqual({
      label: 'ai.openclaw.sifty-scheduler',
      plistPath: `${LAUNCH_AGENTS_DIRECTORY}/ai.openclaw.sifty-scheduler.plist`,
      isIntervalJob: true,
    });
  });

  it('marks only the scheduler as an interval job', () => {
    const definitions = buildServiceDefinitions(LAUNCH_AGENTS_DIRECTORY);

    expect(definitions.webapp.isIntervalJob).toBe(false);
    expect(definitions.ngrok.isIntervalJob).toBe(false);
  });
});

describe('buildInstallablePlistOptions', () => {
  it('builds options only for the services this code installs, not the scheduler', () => {
    expect(
      Object.keys(buildInstallablePlistOptions(PROJECT_DIRECTORY, DEV_SERVER_PORT)).sort()
    ).toEqual(['ngrok', 'webapp']);
  });

  it('writes each service log to the file the tab reads for that service', () => {
    const optionsByServiceName = buildInstallablePlistOptions(PROJECT_DIRECTORY, DEV_SERVER_PORT);

    for (const [serviceName, options] of Object.entries(optionsByServiceName)) {
      expect(options.logFilePath).toBe(LOG_FILE_PATHS_BY_LOG_NAME[serviceName]);
    }
  });

  it('runs the webapp through its wrapper in the project, and ngrok on the dev server port', () => {
    const { webapp, ngrok } = buildInstallablePlistOptions(PROJECT_DIRECTORY, 5175);

    expect(webapp.programArguments).toEqual([
      '/bin/bash',
      `${PROJECT_DIRECTORY}/scripts/sifty-webapp-service.sh`,
    ]);
    expect(webapp.workingDirectory).toBe(PROJECT_DIRECTORY);
    expect(ngrok.programArguments).toEqual([
      '/opt/homebrew/bin/ngrok',
      'http',
      '5175',
      '--log',
      'stdout',
    ]);
  });
});

describe('describeHowToInstallService', () => {
  it('points at npm run services:install only for services it can install', () => {
    const installableServiceNames = Object.keys(
      buildInstallablePlistOptions(PROJECT_DIRECTORY, DEV_SERVER_PORT)
    );

    for (const serviceName of SERVICE_NAMES) {
      expect(describeHowToInstallService(serviceName).includes('npm run services:install')).toBe(
        installableServiceNames.includes(serviceName)
      );
    }
  });
});
