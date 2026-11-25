import { type ServerTabApi, startServerTabButton } from './openServerTab';
import { type ChromeApi, startCookieSync } from './startCookieSync';

declare const chrome: ChromeApi & ServerTabApi;

startCookieSync(chrome, { log: (message) => console.log(`[sifty] ${message}`) });
startServerTabButton(chrome);
