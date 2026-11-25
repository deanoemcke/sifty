import { createElement } from './dom';
import type { LogTail } from './hostClient';

export type LogsSection = {
  showLog(logTail: LogTail): void;
};

export function renderLogsSection(
  container: HTMLElement,
  logNames: string[],
  selectedLogName: string,
  onSelectLog: (logName: string) => void
): LogsSection {
  const select = createElement('select');
  for (const logName of logNames) {
    const option = createElement('option', { text: logName });
    option.value = logName;
    select.append(option);
  }
  select.value = selectedLogName;
  select.addEventListener('change', () => onSelectLog(select.value));

  const lines = createElement('pre', { className: 'log-lines' });
  container.replaceChildren(
    createElement('h2', { text: 'Logs' }),
    createElement('label', { className: 'field' }, [
      createElement('span', { text: 'Log', className: 'field-label' }),
      select,
    ]),
    lines
  );

  return {
    showLog(logTail) {
      lines.textContent = logTail.isLogFilePresent
        ? logTail.logLines.join('\n')
        : 'No log file yet.';
    },
  };
}
