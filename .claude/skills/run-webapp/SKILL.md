---
name: run-webapp
description: Launch the Sifty webapp's dev server and drive it with Playwright to visually verify frontend changes. Use this whenever asked to run, screenshot, or visually check the app in a browser.
---

# Running Sifty in a browser

This is a Vite frontend with no headless-browser CLI installed
(`chromium-cli` is not available here) — drive it with the `playwright`
package that's already a project `devDependency`.

## 1. Start (or find) the dev server

Each git worktree binds to a fixed port: `5173 + <trailing digit in the
worktree dir name>` (main `sifty-webapp` = 5173, `sifty-webapp1` = 5174,
`sifty-webapp2` = 5175, etc — see the repo's root `CLAUDE.md`).

Check whether it's already running before starting a new one:

```bash
lsof -i :<port>                      # e.g. 5174 for sifty-webapp1
curl -sf http://localhost:<port> >/dev/null && echo "server up"
```

If nothing's listening, start it from the worktree's own root:

```bash
npm run dev &
```

## 2. Drive it with Playwright

Write the driver script **inside the project directory** (not `/tmp` or
a scratchpad) — `import { chromium } from "playwright"` only resolves
against the local `node_modules`, so running it from outside the
project fails with `ERR_MODULE_NOT_FOUND`. A `.scratch-*.mjs` name at
the project root works and is easy to delete afterwards.

```js
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto("http://localhost:5174", { waitUntil: "domcontentloaded" });
await page.screenshot({ path: "/absolute/path/to/screenshot.png" });
await browser.close();
```

Run with `node .scratch-verify.mjs`, then delete the script when done.

## 3. Get listings to actually render

The results grid stays empty until a discovery search runs, and the
"Go sifting" button (`#discoveryBtn`) stays **disabled** until its
validation passes (`updateDiscoveryBtn()` in
`src/frontend/discoveryForm.ts`):

- `#discoveryPrompt` — must be non-empty
- `#discoveryMaxPrice` — must be a parseable number
- Either `#discoveryAllowShipping` is checked, **or** `#discoveryRegion`
  has a value selected (pickup-only mode requires a region)

The simplest combination that enables the button:

```js
await page.fill("#discoveryPrompt", "bike");
await page.fill("#discoveryMaxPrice", "500");
await page.click("#discoveryAllowShipping");
await page.click("#discoveryBtn");
```

Cards populate from a live scrape, so wait for them rather than
sleeping a fixed amount:

```js
await page.waitForSelector(".listing-card", { timeout: 30000 });
```
