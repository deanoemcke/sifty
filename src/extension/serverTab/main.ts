// Page entry point for server.html (built to extension/dist/server.js).

import type { ChromeApi } from '../startCookieSync';
import { startServerTab } from './startServerTab';

declare const chrome: ChromeApi;

const POLL_INTERVAL_MS = 30_000;

const root = document.getElementById('app');
if (!root) throw new Error('server.html has no #app element');
void startServerTab(root, {
  chromeApi: chrome,
  nowMs: () => Date.now(),
  pollIntervalMs: POLL_INTERVAL_MS,
});
