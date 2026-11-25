import { describe, expect, it } from 'vitest';
import type { InstalledServiceState } from '../nativeHost/handleMessage';
import { describeService } from './describeService';

function makeState(overrides: Partial<InstalledServiceState> = {}): InstalledServiceState {
  return {
    isInstalled: true,
    isLoaded: true,
    isRunning: true,
    isEnabled: true,
    isIntervalJob: false,
    pid: 4242,
    ...overrides,
  };
}

describe('describeService', () => {
  it('shows a running service as ok, with its process ID, offering Restart and Stop', () => {
    expect(describeService('webapp', makeState())).toEqual({
      title: 'Webapp (dev server)',
      tone: 'ok',
      statusText: 'Running (pid 4242)',
      detail: undefined,
      actions: ['restart', 'stop'],
    });
  });

  it('shows a parked service as neutral "Off", offering only Start', () => {
    expect(
      describeService(
        'scheduler',
        makeState({ isLoaded: false, isRunning: false, isEnabled: false, pid: null })
      )
    ).toEqual({
      title: 'Scheduler',
      tone: 'neutral',
      statusText: 'Off',
      detail: 'Stays off after a login until started here.',
      actions: ['start'],
    });
  });

  it('warns about a service that is enabled but not running, since it should be', () => {
    const view = describeService(
      'ngrok',
      makeState({ isLoaded: false, isRunning: false, isEnabled: true, pid: null })
    );

    expect(view).toMatchObject({
      tone: 'warning',
      statusText: 'Not running',
      actions: ['start', 'stop'],
    });
    expect(view.detail).toContain('start');
  });

  it('warns about a loaded service that has no process', () => {
    expect(describeService('ngrok', makeState({ isRunning: false, pid: null }))).toMatchObject({
      tone: 'warning',
      statusText: 'Loaded but not running',
      actions: ['start', 'stop'],
    });
  });

  it('shows an interval job that is loaded and idle between ticks as healthy, offering only Stop', () => {
    expect(
      describeService('scheduler', makeState({ isIntervalJob: true, isRunning: false, pid: null }))
    ).toMatchObject({ tone: 'ok', statusText: 'Scheduled', actions: ['stop'] });
  });

  it('says the scheduler plist is set up outside this project when it is not installed', () => {
    const view = describeService(
      'scheduler',
      makeState({ isInstalled: false, isLoaded: false, isRunning: false, pid: null })
    );

    expect(view.detail).not.toContain('npm run services:install');
    expect(view.actions).toEqual([]);
  });

  it('says how to install a service that is not installed, and offers no buttons', () => {
    expect(
      describeService(
        'webapp',
        makeState({ isInstalled: false, isLoaded: false, isRunning: false, pid: null })
      )
    ).toEqual({
      title: 'Webapp (dev server)',
      tone: 'neutral',
      statusText: 'Not installed',
      detail: 'Run npm run services:install in the sifty-webapp folder.',
      actions: [],
    });
  });

  it('titles every known service', () => {
    expect(describeService('ngrok', makeState()).title).toBe('ngrok tunnel');
    expect(describeService('scheduler', makeState()).title).toBe('Scheduler');
  });

  it('falls back to the raw name for a service it has no title for', () => {
    expect(describeService('something-new', makeState()).title).toBe('something-new');
  });
});
