# Sifty Server — Chrome extension

A Chrome extension whose full-tab UI ("Sifty Server") keeps Facebook cookies in sync, edits scheduler settings, shows scheduler activity and logs, and starts/stops the webapp server and ngrok. The webapp itself is unchanged and stays reachable through ngrok.

## Problems being solved

- `FB_COOKIES` is exported from a browser and pasted into `.env` by hand; nothing keeps it fresh.
- Scheduler tuning (`TARGET_INTERVAL_MINUTES`, `MAX_SEARCHES_PER_TICK`, `FAILURE_REALERT_MS`) means editing code.
- There is no single view of what the scheduler last did; logs are in `/tmp`.
- The webapp server and ngrok are started by hand from the command line.

## Architecture

```
Chrome
├─ background service worker ── chrome.cookies.onChanged ─┐
└─ "Sifty Server" tab (server.html) ──────────────────────┤  chrome.runtime.connectNative
                                                          ▼
                            native host (Node, started by Chrome on demand)
                               ├─ sifty.db  (settings, facebook_cookies, saved_searches)
                               ├─ launchctl (webapp server, ngrok)
                               └─ /tmp log files

launchd ── scheduler (every 30 min) ── reads settings from sifty.db
launchd ── webapp server (vite) ─────── ngrok
```

Native messaging means no network port and no token: Chrome only lets the extension ID listed in the host manifest's `allowed_origins` talk to the host. Cookie syncing and the settings tab both work when the webapp server is stopped.

## Decisions

- **Full tab, not popup or side panel.** Logs and per-search history need room. A popup closes on blur. Same extension-page mechanics, so reversible. The toolbar button focuses the tab if open, otherwise opens it pinned.
- **Cookies are read with `chrome.cookies`, not a content script.** `xs` is `HttpOnly`; page scripts cannot read it. No page access is needed.
- **Sync runs in the background worker**, debounced a few seconds after the last `onChanged` (Facebook rotates several cookies together). It also runs on browser start and from a "Sync now" button, so a missed update is recovered.
- **Database is the single source of truth** for settings and cookies. The scheduler is a fresh process each tick, so it reads settings at the start of every run: no reload logic.
- **Cookie values are never shown** in the tab or returned to it. Status only: last synced, count, earliest expiry.
- **Desktop Chrome on this Mac only.** Phone access to these controls is a non-goal.

## Phases

Each phase is test-first, ends green, and is committed separately.

### 1. Scheduler settings in the database

- `settings` table created in `initSchema` (key, JSON value, updated_at).
- `getSchedulerSettings(database)` returns typed values with defaults taken from the existing constants; bounds-checked on write (positive integers, sane maximums).
- `runSchedulerAsync` takes its interval, per-tick cap and re-alert window from it. The constants remain as defaults only.
- The launchd tick (`StartInterval`) stays in the plist for now; the tab shows it read-only. Editing it means rewriting the plist and reloading the job, which can follow once the host exists.

### 2. Facebook cookies in the database

- `facebook_cookies` table: one row, cookie JSON plus `synced_at`. Replaced atomically, only after `parseFbCookies` accepts the set.
- `facebook.ts` reads from the database instead of `process.env.FB_COOKIES`; user-facing messages that say "set FB_COOKIES" updated.
- Fix `sameSite` mapping in `toPlaywrightCookies`: Chrome supplies `no_restriction`/`lax`/`strict`/`unspecified`, and the current case-sensitive check turns every cookie into `Lax`. Separate commit.
- `FB_COOKIES` was kept as a fallback while the sync was proven, then removed: the database is the only source.

### 3. Native host

- `native-host/` — a Node script speaking Chrome's length-prefixed JSON protocol over stdin/stdout, plus a wrapper that runs `nvm use` (matching `.nvmrc`, as `run-and-notify.sh` does) so `better-sqlite3` loads.
- Messages (each validated at the boundary; unknown or oversized messages rejected explicitly): `syncCookies`, `getStatus`, `getSettings`, `updateSettings`, `getRunHistory`, `tailLog`, `controlService`.
- `controlService` only accepts a fixed list of service names (webapp server, ngrok, scheduler); nothing is built from free text.
- Logs to a file from the start; "native host has exited" is otherwise undiagnosable.
- An install script writes the host manifest to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.

### 4. Extension

- `extension/` — Manifest V3: background worker (cookie sync), `server.html` tab titled "Sifty Server", toolbar icon that focuses the existing tab or opens a pinned one.
- Pure functions (cookie selection and filtering, status formatting, settings form validation) live in testable modules; the Chrome API calls are thin wrappers.
- Manifest pins a `key` so the extension ID, and therefore `allowed_origins`, is stable across reloads.
- Sections: Server (start/stop/restart, status), Facebook cookies, Scheduler settings, Last runs (from `saved_searches.last_run_*`), Logs.

### 5. launchd services

- LaunchAgent plists for the webapp server and ngrok, in the style of the existing `ai.openclaw.*` agents, started and stopped from the tab via the host.

## Risks and open questions

- Host environment: Chrome starts the host with a minimal environment. Absolute paths and the Node version must match the one `better-sqlite3` was built with.
- Two writers to `sifty.db` (scheduler and host): WAL and a busy timeout are already set in `getDb`; the host must use `getDb`, not open its own connection.
- Shorter `StartInterval` ticks would also ping the dead-man's-switch healthcheck more often; check its grace period before changing the tick.
- Cookies are per Chrome profile; the extension must be installed in the profile that is logged into Facebook.
- Verification of the extension itself (loading it unpacked, exercising the tab) is done by the user in Chrome; it is not part of the automated tests.

## Status

Built and committed: phases 1–5 (scheduler settings, cookie store, native host, extension with cookie sync and the Sifty Server tab, and launchd service control). The `FB_COOKIES` environment variable is no longer read: cookies come only from the database, via the extension.

The cookie status reports when the login cookies (`c_user`, `xs`) expire, not the earliest of all cookies: Facebook's other cookies expire about a week out and say nothing about the session.

## Setup

1. `npm run extension:build` — writes `extension/dist/`.
2. `npm run native-host:install` — registers the native host with Chrome for this extension only. The extension ID comes from the public key in `extension/manifest.json`; the private key was discarded because an unpacked extension does not need it. Re-run it if the checkout moves.
3. `chrome://extensions` → Developer mode → Load unpacked → `extension/dist`. Reload the extension there after each rebuild.
4. Click the toolbar icon to open the Sifty Server tab. The service worker console logs each cookie sync.

### Services (phase 5)

The tab's Services section starts, stops and restarts three launchd user services: the webapp dev server (`ai.openclaw.sifty-webapp`), ngrok (`ai.openclaw.sifty-ngrok`) and the existing scheduler (`ai.openclaw.sifty-scheduler`, whose plist is never rewritten here).

On and off persist. Start runs `launchctl enable` then `bootstrap`; Stop runs `bootout` then `disable`. A service left on starts at login and is restarted if it crashes; one stopped from the tab stays off after a login. This is how the scheduler is already parked on this machine.

The scheduler is a `StartInterval` job, so while loaded it has no process between ticks. The tab shows that as "Scheduled" (healthy) and offers only Stop; Start on it never kicks off an immediate run. A missing scheduler plist is reported as set up outside this project, since `npm run services:install` cannot create it.

5. `npm run services:install` — writes the webapp and ngrok plists into `~/Library/LaunchAgents`. It never starts anything, and a service installed for the first time is also disabled, so nothing runs until Start is pressed in the tab. Re-running rewrites the plists but leaves each service's on/off state alone.
6. Stop any ngrok started by hand before starting the ngrok service: a free ngrok account allows one session. The tab only sees launchd's services, not processes started from a terminal.
7. The webapp service runs the checkout that installed it, on that checkout's port (5173 for the main checkout); ngrok forwards the same port.

Logs the tab can read: `scheduler` and `scheduler-launchd` (written by the scheduler wrapper and launchd), `webapp` and `ngrok` (written by those services), and `native-host` (written by the host's wrapper script). All are in `/tmp`, which macOS clears from time to time.
