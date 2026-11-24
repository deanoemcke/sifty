// The "Sifty Server" tab: loads status from the native host and renders it.

import type { ChromeApi } from '../startCookieSync';
import { createElement } from './dom';
import { createHostClient } from './hostClient';
import { renderCookiesSection, renderHostError, renderRunsSection } from './renderSections';
import { renderSettingsSection } from './renderSettingsSection';

export type ServerTabDependencies = {
  chromeApi: ChromeApi;
  nowMs: () => number;
  pollIntervalMs: number;
};

export async function startServerTab(
  root: HTMLElement,
  dependencies: ServerTabDependencies
): Promise<void> {
  const hostClient = createHostClient(dependencies.chromeApi);

  const hostErrorContainer = createElement('div', { section: 'host-error', className: 'banner' });
  const cookiesContainer = createElement('section', { section: 'cookies' });
  const settingsContainer = createElement('section', { section: 'settings' });
  const runsContainer = createElement('section', { section: 'runs' });
  root.replaceChildren(hostErrorContainer, cookiesContainer, settingsContainer, runsContainer);

  try {
    const [status, runHistory] = await Promise.all([
      hostClient.getStatus(),
      hostClient.getRunHistory(),
    ]);
    renderHostError(hostErrorContainer, undefined);
    renderCookiesSection(cookiesContainer, status.cookies, dependencies.nowMs());
    renderSettingsSection(settingsContainer, status.settings, async (changes) => {
      try {
        return { kind: 'saved', settings: await hostClient.updateSettings(changes) };
      } catch (error) {
        return { kind: 'failed', message: (error as Error).message };
      }
    });
    renderRunsSection(runsContainer, runHistory, dependencies.nowMs());
  } catch (error) {
    renderHostError(hostErrorContainer, error as Error);
  }
}
