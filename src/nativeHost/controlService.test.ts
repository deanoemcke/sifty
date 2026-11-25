import { describe, expect, it } from 'vitest';
import {
  controlServiceAsync,
  getServiceStateAsync,
  type ServiceDefinition,
} from './controlService';
import { makeFakeLaunchd } from './fakeLaunchd';

const LABEL = 'ai.openclaw.sifty-webapp';
const PLIST_PATH = '/Users/someone/Library/LaunchAgents/ai.openclaw.sifty-webapp.plist';
const USER_ID = 501;
const DEFINITION: ServiceDefinition = { label: LABEL, plistPath: PLIST_PATH, isIntervalJob: false };

type FakeLaunchdState = { isLoaded: boolean; isEnabled: boolean; pid: number | null };

function makeFakeService(initial: FakeLaunchdState, failures: Record<string, string> = {}) {
  const fake = makeFakeLaunchd({ [LABEL]: { plistPath: PLIST_PATH, ...initial } }, failures);
  return { ...fake, state: fake.statesByLabel[LABEL] };
}

const STOPPED: FakeLaunchdState = { isLoaded: false, isEnabled: false, pid: null };
const RUNNING: FakeLaunchdState = { isLoaded: true, isEnabled: true, pid: 4242 };

function control(action: 'start' | 'stop' | 'restart', fake: ReturnType<typeof makeFakeService>) {
  return controlServiceAsync({
    action,
    definition: DEFINITION,
    userId: USER_ID,
    runLaunchctlAsync: fake.runLaunchctlAsync,
  });
}

describe('getServiceStateAsync', () => {
  it('reads the state of a running service', async () => {
    const fake = makeFakeService(RUNNING);

    expect(
      await getServiceStateAsync({
        definition: DEFINITION,
        userId: USER_ID,
        runLaunchctlAsync: fake.runLaunchctlAsync,
      })
    ).toEqual({ isLoaded: true, isRunning: true, isEnabled: true, pid: 4242 });
  });
});

describe('controlServiceAsync — start', () => {
  it('does not kick off a run of an interval job that is loaded and idle between ticks', async () => {
    const fake = makeFakeService({ isLoaded: true, isEnabled: true, pid: null });

    await controlServiceAsync({
      action: 'start',
      definition: { ...DEFINITION, isIntervalJob: true },
      userId: USER_ID,
      runLaunchctlAsync: fake.runLaunchctlAsync,
    });

    expect(fake.commands.some(([subcommand]) => subcommand === 'kickstart')).toBe(false);
  });

  it('starts a stopped, disabled service and leaves it enabled so it survives a login', async () => {
    const fake = makeFakeService(STOPPED);

    const result = await control('start', fake);

    expect(result).toMatchObject({ isLoaded: true, isRunning: true, isEnabled: true });
    expect(fake.state).toMatchObject({ isLoaded: true, isEnabled: true });
  });

  it('does nothing harmful when the service is already running', async () => {
    const fake = makeFakeService(RUNNING);

    const result = await control('start', fake);

    expect(result).toMatchObject({ isRunning: true, pid: 4242 });
  });

  it('starts a service that is loaded but has no process', async () => {
    const fake = makeFakeService({ isLoaded: true, isEnabled: true, pid: null });

    const result = await control('start', fake);

    expect(result.isRunning).toBe(true);
  });
});

describe('controlServiceAsync — stop', () => {
  it('stops a running service and parks it disabled so it stays off after a login', async () => {
    const fake = makeFakeService(RUNNING);

    const result = await control('stop', fake);

    expect(result).toEqual({ isLoaded: false, isRunning: false, isEnabled: false, pid: null });
  });

  it('is harmless when the service is already stopped', async () => {
    const fake = makeFakeService(STOPPED);

    const result = await control('stop', fake);

    expect(result).toMatchObject({ isLoaded: false, isEnabled: false });
  });

  it('disables a service that is enabled but not loaded', async () => {
    const fake = makeFakeService({ isLoaded: false, isEnabled: true, pid: null });

    const result = await control('stop', fake);

    expect(result.isEnabled).toBe(false);
  });
});

describe('controlServiceAsync — restart', () => {
  it('gives a running service a new process', async () => {
    const fake = makeFakeService(RUNNING);

    const result = await control('restart', fake);

    expect(result.isRunning).toBe(true);
    expect(result.pid).not.toBe(4242);
  });

  it('starts a stopped service', async () => {
    const fake = makeFakeService(STOPPED);

    const result = await control('restart', fake);

    expect(result).toMatchObject({ isRunning: true, isEnabled: true });
  });
});

describe('controlServiceAsync — failures', () => {
  it("surfaces launchctl's own message when a step fails", async () => {
    const fake = makeFakeService(STOPPED, { bootstrap: 'Bootstrap failed: 5: Input/output error' });

    await expect(control('start', fake)).rejects.toThrow(
      /launchctl bootstrap.*Bootstrap failed: 5: Input\/output error/
    );
  });

  it('stops after a failed step instead of carrying on', async () => {
    const fake = makeFakeService(STOPPED, { enable: 'Could not enable' });

    await expect(control('start', fake)).rejects.toThrow(/launchctl enable/);

    expect(fake.commands.some(([subcommand]) => subcommand === 'bootstrap')).toBe(false);
  });

  it('addresses the per-user domain with the plist path it was given', async () => {
    const fake = makeFakeService(STOPPED);

    await control('start', fake);

    expect(fake.commands).toContainEqual(['bootstrap', `gui/${USER_ID}`, PLIST_PATH]);
    expect(fake.commands).toContainEqual(['enable', `gui/${USER_ID}/${LABEL}`]);
  });
});
