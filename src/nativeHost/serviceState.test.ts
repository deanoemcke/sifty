import { describe, expect, it } from 'vitest';
import { parseServiceState } from './serviceState';

// Abbreviated from real `launchctl list {label}` output on macOS 15.
const LIST_OUTPUT_RUNNING = `{
\t"StandardOutPath" = "/tmp/signal-notify-proxy.log";
\t"LimitLoadToSessionType" = "Aqua";
\t"Label" = "ai.openclaw.signal-notify-proxy";
\t"OnDemand" = false;
\t"LastExitStatus" = 0;
\t"PID" = 2558;
\t"Program" = "/opt/homebrew/bin/node";
};
`;

const LIST_OUTPUT_LOADED_NOT_RUNNING = `{
\t"LimitLoadToSessionType" = "Aqua";
\t"Label" = "com.apple.SafariHistoryServiceAgent";
\t"OnDemand" = true;
\t"LastExitStatus" = 0;
\t"Program" = "/System/Cryptexes/App/usr/libexec/SafariHistoryServiceAgent";
};
`;

// `launchctl list` exits 113 ("Could not find service") for a job that isn't loaded.
const LIST_EXIT_NOT_LOADED = 113;

// From `launchctl print-disabled gui/{uid}`.
const PRINT_DISABLED_OUTPUT = `
\tdisabled services = {
\t\t"com.docker.helper" => enabled
\t\t"ai.openclaw.battery-keepawake" => disabled
\t\t"ai.openclaw.sifty-scheduler" => disabled
\t\t"ai.openclaw.gateway" => enabled
\t}
`;

describe('parseServiceState', () => {
  it('reads a running service: loaded, running, with its process ID', () => {
    expect(
      parseServiceState({
        label: 'ai.openclaw.signal-notify-proxy',
        listExitCode: 0,
        listOutput: LIST_OUTPUT_RUNNING,
        printDisabledOutput: PRINT_DISABLED_OUTPUT,
      })
    ).toEqual({ isLoaded: true, isRunning: true, isEnabled: true, pid: 2558 });
  });

  it('reads a loaded service that has no process as not running', () => {
    expect(
      parseServiceState({
        label: 'com.apple.SafariHistoryServiceAgent',
        listExitCode: 0,
        listOutput: LIST_OUTPUT_LOADED_NOT_RUNNING,
        printDisabledOutput: PRINT_DISABLED_OUTPUT,
      })
    ).toEqual({ isLoaded: true, isRunning: false, isEnabled: true, pid: null });
  });

  it('reads an unloaded, disabled service — how the scheduler is parked', () => {
    expect(
      parseServiceState({
        label: 'ai.openclaw.sifty-scheduler',
        listExitCode: LIST_EXIT_NOT_LOADED,
        listOutput: 'Could not find service "ai.openclaw.sifty-scheduler" in domain for port',
        printDisabledOutput: PRINT_DISABLED_OUTPUT,
      })
    ).toEqual({ isLoaded: false, isRunning: false, isEnabled: false, pid: null });
  });

  it('treats a service missing from the disabled list as enabled', () => {
    expect(
      parseServiceState({
        label: 'ai.openclaw.sifty-webapp',
        listExitCode: LIST_EXIT_NOT_LOADED,
        listOutput: 'Could not find service',
        printDisabledOutput: PRINT_DISABLED_OUTPUT,
      })
    ).toMatchObject({ isLoaded: false, isEnabled: true });
  });

  it('reports a service that is disabled but still running, until it is stopped', () => {
    expect(
      parseServiceState({
        label: 'ai.openclaw.sifty-scheduler',
        listExitCode: 0,
        listOutput: LIST_OUTPUT_RUNNING,
        printDisabledOutput: PRINT_DISABLED_OUTPUT,
      })
    ).toMatchObject({ isLoaded: true, isRunning: true, isEnabled: false });
  });

  it('matches the whole label, not a prefix of a longer one', () => {
    expect(
      parseServiceState({
        label: 'ai.openclaw.sifty',
        listExitCode: LIST_EXIT_NOT_LOADED,
        listOutput: 'Could not find service',
        printDisabledOutput: PRINT_DISABLED_OUTPUT,
      })
    ).toMatchObject({ isEnabled: true });
  });

  it('refuses to guess when launchctl fails for another reason', () => {
    expect(() =>
      parseServiceState({
        label: 'ai.openclaw.sifty-webapp',
        listExitCode: 1,
        listOutput: 'launchctl: something unexpected',
        printDisabledOutput: PRINT_DISABLED_OUTPUT,
      })
    ).toThrow(/launchctl list.*exit code 1/);
  });
});
