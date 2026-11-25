import type { ServiceAction } from '../../nativeHost/controlService';
import type { InstalledServiceState } from '../../nativeHost/handleMessage';
import { describeService } from '../describeService';
import { createElement } from './dom';

export type ServicesSectionActions = {
  message: string | undefined;
  isDisabled: boolean;
  onAction: (serviceName: string, action: ServiceAction) => void;
};

const ACTION_LABELS: Record<ServiceAction, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
};

export function renderServicesSection(
  container: HTMLElement,
  servicesByName: Record<string, InstalledServiceState>,
  actions: ServicesSectionActions
): void {
  const rows = Object.entries(servicesByName).map(([serviceName, state]) => {
    const view = describeService(serviceName, state);
    const buttons = view.actions.map((action) => {
      const button = createElement('button', { text: ACTION_LABELS[action] });
      button.dataset.action = action;
      button.disabled = actions.isDisabled;
      button.addEventListener('click', () => actions.onAction(serviceName, action));
      return button;
    });

    const row = createElement('li', { className: 'service' }, [
      createElement('span', { text: view.title, className: 'service-name' }),
      createElement('span', {
        text: view.statusText,
        className: `service-status tone-${view.tone}`,
      }),
      ...(view.detail
        ? [createElement('span', { text: view.detail, className: 'detail service-detail' })]
        : []),
      createElement('span', { className: 'service-actions' }, buttons),
    ]);
    row.dataset.service = serviceName;
    return row;
  });

  container.replaceChildren(
    createElement('h2', { text: 'Services' }),
    createElement('ul', { className: 'services' }, rows),
    ...(actions.message
      ? [createElement('p', { text: actions.message, className: 'tone-problem' })]
      : [])
  );
}
