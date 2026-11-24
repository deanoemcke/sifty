import type { RunHistoryEntry } from '../../nativeHost/handleMessage';
import type { FacebookCookieStatus } from '../../server/facebookCookies';
import { type CookieStatusView, describeCookieStatus } from '../describeCookieStatus';
import { describeRunHistory, type RunHistoryRowView } from '../describeRunHistory';
import { createElement } from './dom';
import { HostUnreachableError } from './hostClient';

export function renderHostError(container: HTMLElement, error: Error | undefined): void {
  container.replaceChildren();
  container.hidden = error === undefined;
  if (error === undefined) return;

  const advice =
    error instanceof HostUnreachableError
      ? ` Run "npm run native-host:install" in the sifty-webapp folder, then reload this extension.`
      : '';
  const message =
    error instanceof HostUnreachableError
      ? `Can't reach the Sifty native host: ${error.message}.${advice}`
      : `The Sifty native host reported an error: ${error.message}`;
  container.append(createElement('p', { text: message, className: 'tone-problem' }));
}

function renderCookieView(view: CookieStatusView): Node[] {
  return [
    createElement('p', { text: view.headline, className: `headline tone-${view.tone}` }),
    createElement('p', { text: view.detail, className: 'detail' }),
  ];
}

export function renderCookiesSection(
  container: HTMLElement,
  status: FacebookCookieStatus | undefined,
  nowMs: number
): void {
  container.replaceChildren(
    createElement('h2', { text: 'Facebook cookies' }),
    ...(status ? renderCookieView(describeCookieStatus(status, nowMs)) : [])
  );
}

function renderRunRow(row: RunHistoryRowView): HTMLElement {
  return createElement(
    'li',
    { className: `run run-${row.result}${row.isOverdue ? ' overdue' : ''}` },
    [
      createElement('span', { text: row.name, className: 'run-name' }),
      createElement('span', { text: `Last run: ${row.lastRunText}`, className: 'run-last' }),
      createElement('span', { text: row.dueText, className: 'run-due' }),
      ...row.failureLines.map((line) =>
        createElement('pre', { text: line, className: 'run-failure' })
      ),
    ]
  );
}

export function renderRunsSection(
  container: HTMLElement,
  entries: RunHistoryEntry[] | undefined,
  nowMs: number
): void {
  const rows = entries ? describeRunHistory(entries, nowMs) : [];
  container.replaceChildren(
    createElement('h2', { text: 'Last runs' }),
    ...(entries && rows.length === 0
      ? [
          createElement('p', {
            text: 'No saved searches have alerts turned on.',
            className: 'detail',
          }),
        ]
      : []),
    createElement('ul', { className: 'runs' }, rows.map(renderRunRow))
  );
}
