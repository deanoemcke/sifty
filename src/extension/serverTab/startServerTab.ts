import type { ServiceAction } from '../../nativeHost/controlService';
import { describeError } from '../../nativeHost/describeError';
import type { InstalledServiceState } from '../../nativeHost/handleMessage';
import { LOG_FILE_PATHS_BY_LOG_NAME } from '../../nativeHost/logFiles';
import { type ChromeApi, describeSyncOutcome, syncFacebookCookiesAsync } from '../startCookieSync';
import { createElement } from './dom';
import { createHostClient, type LogStream, type LogTail } from './hostClient';
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
const DEFAULT_LOG_NAME = 'native-host';
const MESSAGE_LIFETIME_MS = 60_000;

type TimedMessage = { text: string; shownAtMs: number };

type ServerTabState = {
  selectedLogName: string;
  syncMessage: TimedMessage | undefined;
  serviceMessage: TimedMessage | undefined;
  isSettingsRendered: boolean;
  isRefreshing: boolean;
  isRefreshQueued: boolean;
  isServiceActionRunning: boolean;
  logTailsByLogName: Record<string, LogTail>;
  logStream: LogStream | undefined;
  servicesByName: Record<string, InstalledServiceState> | undefined;
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
    logTailsByLogName: {},
    logStream: undefined,
    servicesByName: undefined,
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
    logsContainer,
    runsContainer
  );

  const logsSection = renderLogsSection(
    logsContainer,
    Object.keys(LOG_FILE_PATHS_BY_LOG_NAME),
    state.selectedLogName,
    (logName) => {
      state.selectedLogName = logName;
      showSelectedLog();
    }
  );

  function showSelectedLog(): void {
    const logTail = state.logTailsByLogName[state.selectedLogName];
    if (logTail) logsSection.showLog(logTail);
    else logsSection.showMessage('Waiting for the log…');
  }

  function handleLogTail(logName: string, logTail: LogTail): void {
    state.logTailsByLogName[logName] = logTail;
    if (logName === state.selectedLogName) logsSection.showLog(logTail);
  }

  function handleLogStreamClosed(error: Error): void {
    state.logStream = undefined;
    logsSection.showMessage(`Live logs stopped: ${describeError(error)}. Retrying shortly.`);
  }

  function openLogStream(): void {
    if (state.logStream) return;
    try {
      state.logStream = hostClient.openLogStream(LOG_LINES_SHOWN, {
        onLogTail: handleLogTail,
        onError: (error) => logsSection.showMessage(describeError(error)),
        onClosed: handleLogStreamClosed,
      });
    } catch (error) {
      logsSection.showMessage(`Live logs unavailable: ${describeError(error)}`);
    }
  }

  function closeLogStream(): void {
    state.logStream?.close();
    state.logStream = undefined;
  }

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

  function renderServices(): void {
    if (!state.servicesByName) return;
    renderServicesSection(servicesContainer, state.servicesByName, {
      message: state.serviceMessage?.text,
      isDisabled: state.isServiceActionRunning,
      onAction: (serviceName, action) => void controlServiceAsync(serviceName, action),
    });
  }

  async function controlServiceAsync(serviceName: string, action: ServiceAction): Promise<void> {
    if (state.isServiceActionRunning) return;
    state.isServiceActionRunning = true;
    renderServices();
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
    renderServices();
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
      const { services, status, runHistory } = await hostClient.getPanels();
      const panelResults = [
        { panelName: 'Services', result: services },
        { panelName: 'Cookies and settings', result: status },
        { panelName: 'Last runs', result: runHistory },
      ];
      const failedPanelNames = panelResults
        .filter(({ result }) => result.status === 'rejected')
        .map(({ panelName }) => panelName);
      renderHostError(
        hostErrorContainer,
        panelResults.flatMap(({ result }) => (result.status === 'rejected' ? [result.reason] : [])),
        failedPanelNames
      );
      if (services.status === 'fulfilled') {
        state.servicesByName = services.value;
        renderServices();
      }
      if (status.status === 'fulfilled') {
        renderCookiesSection(cookiesContainer, status.value.cookies, nowMs(), {
          syncMessage: state.syncMessage?.text,
          onSyncNow: () => void syncNowAsync(),
        });
        if (!state.isSettingsRendered) {
          renderSettingsSection(settingsContainer, status.value.settings, async (changes) => {
            try {
              return { kind: 'saved', settings: await hostClient.updateSettings(changes) };
            } catch (error) {
              return { kind: 'failed', message: describeError(error) };
            }
          });
          state.isSettingsRendered = true;
        }
      }
      if (runHistory.status === 'fulfilled') {
        renderRunsSection(runsContainer, runHistory.value, nowMs());
      }
    } catch (error) {
      renderHostError(hostErrorContainer, [error as Error], []);
    } finally {
      state.isRefreshing = false;
    }
    if (state.isRefreshQueued) await refreshAsync();
  }

  function refreshVisiblePage(): void {
    void refreshAsync();
    openLogStream();
  }

  function onPollTick(): void {
    if (!document.hidden) refreshVisiblePage();
  }

  function onVisibilityChange(): void {
    if (document.hidden) closeLogStream();
    else refreshVisiblePage();
  }

  showSelectedLog();
  openLogStream();
  await refreshAsync();
  setInterval(onPollTick, dependencies.pollIntervalMs);
  document.addEventListener('visibilitychange', onVisibilityChange);
}
