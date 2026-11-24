import type { ServiceAction } from '../nativeHost/controlService';
import type { InstalledServiceState } from '../nativeHost/handleMessage';
import type { StatusTone } from './describeCookieStatus';

export type ServiceView = {
  title: string;
  tone: StatusTone;
  statusText: string;
  detail: string | undefined;
  actions: ServiceAction[];
};

const SERVICE_TITLES: Record<string, string> = {
  webapp: 'Webapp (dev server)',
  ngrok: 'ngrok tunnel',
  scheduler: 'Scheduler',
};

export function describeService(serviceName: string, state: InstalledServiceState): ServiceView {
  const title = SERVICE_TITLES[serviceName] ?? serviceName;

  if (!state.isInstalled) {
    return {
      title,
      tone: 'neutral',
      statusText: 'Not installed',
      detail: 'Run npm run services:install in the sifty-webapp folder.',
      actions: [],
    };
  }
  if (state.isRunning) {
    return {
      title,
      tone: 'ok',
      statusText: `Running (pid ${state.pid})`,
      detail: undefined,
      actions: ['restart', 'stop'],
    };
  }
  if (state.isLoaded) {
    return {
      title,
      tone: 'warning',
      statusText: 'Loaded but not running',
      detail: 'Use start to launch it, or stop to take it off.',
      actions: ['start', 'stop'],
    };
  }
  if (state.isEnabled) {
    return {
      title,
      tone: 'warning',
      statusText: 'Not running',
      detail: 'It is set to run, so use start; or stop to keep it off.',
      actions: ['start', 'stop'],
    };
  }
  // Disabled and unloaded is the deliberate "off" — how the scheduler is parked.
  return {
    title,
    tone: 'neutral',
    statusText: 'Off',
    detail: 'Stays off after a login until started here.',
    actions: ['start'],
  };
}
