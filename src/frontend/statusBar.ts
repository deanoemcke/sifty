// ── Global status bar ─────────────────────────────────────────────────────────
// Sole writer of the #statusBar element for plain messages. Deep-search status
// (which adds a cancel button) has its own writer alongside the deep-search
// logic.

import { getElement } from './domUtils';
import { esc } from './html';

export function setStatus(
  statusMessage: string | null,
  type: 'info' | 'success' | 'error' = 'info'
): void {
  const statusBar = getElement('statusBar');
  if (!statusMessage) {
    statusBar.classList.add('hidden');
    return;
  }
  statusBar.className = `status-bar ${type}`;
  statusBar.innerHTML =
    type === 'info'
      ? `<span class="spinner"></span><span>${esc(statusMessage)}</span>`
      : `<span>${esc(statusMessage)}</span>`;
  statusBar.classList.remove('hidden');
}
