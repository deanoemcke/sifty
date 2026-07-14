// Server-side only — loads .env into process.env. Shared by vite.config.ts
// (dev server) and scripts/scheduler.ts (headless CLI), which both need the
// same env vars available outside of any Vite-managed request lifecycle.

import { loadEnv } from 'vite';

export function loadServerEnv(): void {
  Object.assign(process.env, loadEnv('development', process.cwd(), ''));
}
