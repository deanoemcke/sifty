---
name: run-webapp
description: Launch the Sifty webapp's dev server and drive it with Playwright to visually verify frontend changes. Use this whenever asked to run, screenshot, or visually check the app in a browser.
---

# Running Sifty in a browser

This is a Vite frontend with no headless-browser CLI installed
(`chromium-cli` is not available here) — drive it with the `playwright`
package that's already a project `devDependency`.

## Before you start

This step is expensive and failure-prone (wrong port, server not ready,
browser launch issues have repeatedly blown out sessions). Never invoke
this skill automatically as a default "verify it worked" step — always
ask the user first. Often it's faster and cheaper for them to check
themselves.

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

## 4. Gotchas from writing verification scripts

**Native `confirm()`/`alert()` dialogs block forever without a handler.**
Register `page.on("dialog", ...)` *before* the click that triggers it, or
the script hangs waiting for a human:

```js
page.on("dialog", (dialog) => dialog.accept()); // or .dismiss() to test the decline path
```

**Don't locate a specific dynamic row by position or by transient DOM
state.** Cards can get reordered/reparented — e.g. URL cards matching a
known recipe get moved into a `.url-group` wrapper by `syncUrlGroups()`,
so a freshly-added card isn't reliably "last" in `.source-url-row`
order, and `.nth(n)` breaks. Likewise, don't filter on state like
`:not([readonly])` to mean "the new one" — an existing card can
transiently share that state (e.g. before its own search request
resolves). Instead, set a distinctive value and re-find the row by that
value right before acting on it:

```js
await page.evaluate((url) => {
  const input = [...document.querySelectorAll(".url-input")].find((el) => el.value === "");
  input.value = url;
  input.dispatchEvent(new Event("input", { bubbles: true })); // real 'input' event, not just .fill()
}, NEW_URL);
// ...later, right before clicking:
const rowIndex = await page.evaluate(
  (url) => [...document.querySelectorAll(".source-url-row")]
    .findIndex((row) => row.querySelector(".url-input")?.value === url),
  NEW_URL
);
await page.locator(".source-url-row").nth(rowIndex).locator(".url-remove-btn").click();
```

**The dev database persists across script runs.** Saved searches (and
other writes) created by one run are still there on the next — don't
assert on exact row counts against fixed names, or a second run sees
stale data from the first and looks broken. Use a run-unique suffix for
anything you create (e.g. a random/timestamp id passed as an arg), and
clean up afterward:

```bash
node -e "
const db = new (require('better-sqlite3'))('data/sifty.db');
for (const r of db.prepare(\"SELECT id FROM saved_searches WHERE name LIKE 'Verify %'\").all())
  db.prepare('DELETE FROM saved_searches WHERE id = ?').run(r.id);
"
```
