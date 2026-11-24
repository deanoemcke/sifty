// Service worker entry point (built to extension/dist/background.js).

import { type ChromeApi, startCookieSync } from './startCookieSync';

declare const chrome: ChromeApi;

startCookieSync(chrome, { log: (message) => console.log(`[sifty] ${message}`) });
