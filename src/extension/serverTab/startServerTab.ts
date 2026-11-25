// The "Sifty Server" tab: loads status from the native host, renders it, and
// keeps it fresh.

import type { ServiceAction } from '../../nativeHost/controlService';
import { describeError } from '../../nativeHost/describeError';
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
// A sync or service message carries no timestamp on screen, so it is dropped
// before it can read as current.
const MESSAGE_LIFETIME_MS = 60_000;

type TimedMessage = { text: string; shownAtMs: number };

// What the tab remembers between refreshes: plain data, not read back from the DOM.
type ServerTabState = {
  selectedLogName: string;
  syncMessage: TimedMessage | undefined;
  serviceMessage: TimedMessage | undefined;
  isSettingsRendered: boolean;
  isRefreshing: boolean;
  // A refresh was asked for while another was in flight: that one may have
  // fetched the old log or read the service before an action finished.
  isRefreshQueued: boolean;
  isServiceActionRunning: boolean;
};

function isMessageExpired(message: TimedMessage, currentMs: number): boolean {
  return currentMs - message.shownAtMs >= MESSAGE_LIFETIME_MS;
}

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
    isRefreshQueued: false,
    isServiceActionRunning: false,
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
    let text: string;
    try {
      text = describeSyncOutcome(await syncFacebookCookiesAsync(chromeApi));
    } catch (error) {
      text = `Cookie sync failed: ${describeError(error)}`;
    }
    state.syncMessage = { text, shownAtMs: nowMs() };
    await refreshAsync();
  }

  async function controlServiceAsync(serviceName: string, action: ServiceAction): Promise<void> {
    // Each host call takes seconds, and a second Start sent meanwhile would fail
    // against the service the first has just loaded.
    if (state.isServiceActionRunning) return;
    state.isServiceActionRunning = true;
    try {
      await hostClient.controlService(serviceName, action);
      state.serviceMessage = undefined;
    } catch (error) {
      state.serviceMessage = {
        text: `Could not ${action} ${serviceName}: ${describeError(error)}`,
        shownAtMs: nowMs(),
      };
    } finally {
      state.isServiceActionRunning = false;
    }
    await refreshAsync();
  }

  async function refreshAsync(): Promise<void> {
    if (state.isRefreshing) {
      state.isRefreshQueued = true;
      return;
    }
    state.isRefreshing = true;
    state.isRefreshQueued = false;
    try {
      const currentMs = nowMs();
      if (state.syncMessage && isMessageExpired(state.syncMessage, currentMs)) {
        state.syncMessage = undefined;
      }
      if (state.serviceMessage && isMessageExpired(state.serviceMessage, currentMs)) {
        state.serviceMessage = undefined;
      }
      const [services, status, runHistory, logTail] = await Promise.all([
        hostClient.getServices(),
        hostClient.getStatus(),
        hostClient.getRunHistory(),
        hostClient.tailLog(state.selectedLogName, LOG_LINES_SHOWN),
      ]);
      renderHostError(hostErrorContainer, undefined);
      renderServicesSection(servicesContainer, services, {
        message: state.serviceMessage?.text,
        onAction: (serviceName, action) => void controlServiceAsync(serviceName, action),
      });
      renderCookiesSection(cookiesContainer, status.cookies, nowMs(), {
        syncMessage: state.syncMessage?.text,
        onSyncNow: () => void syncNowAsync(),
      });
      // Rendered only once: later refreshes must not overwrite what is typed.
      if (!state.isSettingsRendered) {
        renderSettingsSection(settingsContainer, status.settings, async (changes) => {
          try {
            return { kind: 'saved', settings: await hostClient.updateSettings(changes) };
          } catch (error) {
            return { kind: 'failed', message: describeError(error) };
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
    if (state.isRefreshQueued) await refreshAsync();
  }

  function onPollTick(): void {
    // The tab is usually in the background, where nobody sees the output.
    if (!document.hidden) void refreshAsync();
  }

  function onVisibilityChange(): void {
    if (!document.hidden) void refreshAsync();
  }

  await refreshAsync();
  setInterval(onPollTick, dependencies.pollIntervalMs);
  document.addEventListener('visibilitychange', onVisibilityChange);
}
