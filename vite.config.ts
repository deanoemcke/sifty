import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig } from 'vite';
import { createProviderCooldownStore } from './src/server/ai';
import { loadServerEnv } from './src/server/env';
import { parseFbCookies } from './src/server/recipes/facebook';
import { handleAiFilter } from './src/server/routes/aiFilter';
import { handleCacheClear } from './src/server/routes/cacheRoutes';
import { handleCancelSearch } from './src/server/routes/cancelSearch';
import { handleDeepSearch } from './src/server/routes/deepSearch';
import { handleDiscover } from './src/server/routes/discover';
import { handleQuickSearch } from './src/server/routes/quickSearch';
import { handleRegions } from './src/server/routes/regions';
import {
  handleCreateSavedSearch,
  handleDeleteSavedSearch,
  handleGetSavedSearch,
  handleListSavedSearches,
  handlePatchSavedSearch,
} from './src/server/routes/savedSearches';
import { getWorktreeLabel, getWorktreePort } from './vite.config.helpers';

loadServerEnv();

// Composition root: one cooldown store for the life of the dev server process,
// threaded explicitly into every route handler that needs AI provider rotation —
// see `createProviderCooldownStore` in `src/server/ai.ts`.
const providerCooldownStore = createProviderCooldownStore();

type Next = (err?: unknown) => void;

export default defineConfig({
  define: {
    __WORKTREE_LABEL__: JSON.stringify(getWorktreeLabel(process.cwd())),
  },
  server: {
    port: getWorktreePort(process.cwd()),
    strictPort: true,
    allowedHosts: ['sandbag-crumpled-numbly.ngrok-free.dev'],
  },
  plugins: [
    {
      name: 'sifty-api',
      configureServer(server) {
        const fbCookies = parseFbCookies(process.env.FB_COOKIES);
        console.log(`[startup] FB_COOKIES valid — ${fbCookies.length} cookie(s) loaded`);

        server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: Next) => {
          const urlPath = req.url?.split('?')[0] ?? '';

          // ── GET routes ────────────────────────────────────────────────────────

          if (urlPath === '/api/saved-searches' && req.method === 'GET') {
            handleListSavedSearches(req, res);
            return;
          }
          if (urlPath.startsWith('/api/saved-searches/') && req.method === 'GET') {
            const id = urlPath.slice('/api/saved-searches/'.length);
            handleGetSavedSearch(req, res, id);
            return;
          }
          if (urlPath.startsWith('/api/saved-searches/') && req.method === 'DELETE') {
            const id = urlPath.slice('/api/saved-searches/'.length);
            handleDeleteSavedSearch(req, res, id);
            return;
          }
          if (urlPath.startsWith('/api/saved-searches/') && req.method === 'PATCH') {
            const id = urlPath.slice('/api/saved-searches/'.length);
            await handlePatchSavedSearch(req, res, id);
            return;
          }
          if (urlPath === '/api/regions' && req.method === 'GET') {
            handleRegions(req, res);
            return;
          }

          if (req.method !== 'POST') {
            next();
            return;
          }

          // ── POST routes ───────────────────────────────────────────────────────

          if (urlPath === '/api/cancel-search') {
            await handleCancelSearch(req, res);
            return;
          }
          if (urlPath === '/api/quick-search') {
            await handleQuickSearch(req, res);
            return;
          }
          if (urlPath === '/api/deep-search') {
            await handleDeepSearch(req, res);
            return;
          }
          if (urlPath === '/api/cache/clear') {
            await handleCacheClear(req, res);
            return;
          }
          if (urlPath === '/api/ai-filter') {
            await handleAiFilter(req, res, providerCooldownStore);
            return;
          }
          if (urlPath === '/api/discover') {
            await handleDiscover(req, res, providerCooldownStore);
            return;
          }
          if (urlPath === '/api/saved-searches') {
            await handleCreateSavedSearch(req, res);
            return;
          }

          next();
        });
      },
    },
  ],
});
