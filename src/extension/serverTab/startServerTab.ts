// The "Sifty Server" tab: loads status from the native host, renders it, and
// keeps it fresh.

import type { ServiceAction } from '../../nativeHost/controlService';
import { LOG_FILE_PATHS_BY_LOG_NAME } from '../../nativeHost/logFiles';
import { type ChromeApi, describeSyncOutcome, syncFacebookCookiesAsync } from '../startCookieSync';
import { createElement } from './dom';
import { createHostClient } from './hostClient';
import { renderLogsSection } from './renderLogsSection';
import { renderCookiesSection, renderHostError, renderRunsSection } from './renderSections';
import { renderServicesSection } from './renderServicesSection';
import { renderSettingsSection } from './renderSettingsSection';

export type ServerTabDependencies = {
  chromeApi: ChromeApi;
  nowMs: () => number;
  pollIntervalMs: number;
};

const LOG_LINES_SHOWN = 200;
const DEFAULT_LOG_NAME = 'scheduler';

// What the tab remembers between refreshes: plain data, not read back from the DOM.
type ServerTabState = {
  selectedLogName: string;
  syncMessage: string | undefined;
  serviceMessage: string | undefined;
  isSettingsRendered: boolean;
  isRefreshing: boolean;
};

export async function startServerTab(
  root: HTMLElement,
  dependencies: ServerTabDependencies
): Promise<void> {
  const { chromeApi, nowMs } = dependencies;
  const hostClient = createHostClient(chromeApi);
  const state: ServerTabState = {
    selectedLogName: DEFAULT_LOG_NAME,
    syncMessage: undefined,
    serviceMessage: undefined,
    isSettingsRendered: false,
    isRefreshing: false,
  };

  const hostErrorContainer = createElement('div', { section: 'host-error', className: 'banner' });
  const servicesContainer = createElement('section', { section: 'services' });
  const cookiesContainer = createElement('section', { section: 'cookies' });
  const settingsContainer = createElement('section', { section: 'settings' });
  const runsContainer = createElement('section', { section: 'runs' });
  const logsContainer = createElement('section', { section: 'logs' });
  root.replaceChildren(
    hostErrorContainer,
    servicesContainer,
    cookiesContainer,
    settingsContainer,
    runsContainer,
    logsContainer
  );

  const logsSection = renderLogsSection(
    logsContainer,
    Object.keys(LOG_FILE_PATHS_BY_LOG_NAME),
    state.selectedLogName,
    (logName) => {
      state.selectedLogName = logName;
      void refreshAsync();
    }
  );

  async function syncNowAsync(): Promise<void> {
    try {
      state.syncMessage = describeSyncOutcome(await syncFacebookCookiesAsync(chromeApi));
    } catch (error) {
      state.syncMessage = `Cookie sync failed: ${(error as Error).message}`;
    }
    await refreshAsync();
  }

  async function controlServiceAsync(serviceName: string, action: ServiceAction): Promise<void> {
    try {
      await hostClient.controlService(serviceName, action);
      state.serviceMessage = undefined;
    } catch (error) {
      state.serviceMessage = `Could not ${action} ${serviceName}: ${(error as Error).message}`;
    }
    await refreshAsync();
  }

  async function refreshAsync(): Promise<void> {
    if (state.isRefreshing) return;
    state.isRefreshing = true;
    try {
      const [services, status, runHistory, logTail] = await Promise.all([
        hostClient.getServices(),
        hostClient.getStatus(),
        hostClient.getRunHistory(),
        hostClient.tailLog(state.selectedLogName, LOG_LINES_SHOWN),
      ]);
      renderHostError(hostErrorContainer, undefined);
      renderServicesSection(servicesContainer, services, {
        message: state.serviceMessage,
        onAction: (serviceName, action) => void controlServiceAsync(serviceName, action),
      });
      renderCookiesSection(cookiesContainer, status.cookies, nowMs(), {
        syncMessage: state.syncMessage,
        onSyncNow: () => void syncNowAsync(),
      });
      // Rendered only once: later refreshes must not overwrite what is typed.
      if (!state.isSettingsRendered) {
        renderSettingsSection(settingsContainer, status.settings, async (changes) => {
          try {
            return { kind: 'saved', settings: await hostClient.updateSettings(changes) };
          } catch (error) {
            return { kind: 'failed', message: (error as Error).message };
          }
        });
        state.isSettingsRendered = true;
      }
      renderRunsSection(runsContainer, runHistory, nowMs());
      logsSection.showLog(logTail);
    } catch (error) {
      renderHostError(hostErrorContainer, error as Error);
    } finally {
      state.isRefreshing = false;
    }
  }

  await refreshAsync();
  setInterval(() => void refreshAsync(), dependencies.pollIntervalMs);
}
