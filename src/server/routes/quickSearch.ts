// Server-side only — POST /api/quick-search route handler.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireString } from '../../lib/validate';
import { cancelSearch, cleanupSearch, isSearchCancelled, registerSearch } from '../cancellation';
import { getDb } from '../db';
import { readBody, sendJSON, sse, startSSE } from '../helpers';
import { getRecipeForUrl } from '../recipes/registry';
import { runQuickSearchForUrlAsync } from '../services/quickSearch';

export type {
  QuickSearchCacheEvent,
  QuickSearchRunResult,
} from '../services/quickSearch';
export { normalizeCachedListings, runQuickSearchForUrlAsync } from '../services/quickSearch';

export async function handleQuickSearch(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = await readBody(request).catch(() => null);

  let url: string;
  try {
    url = requireString((body as Record<string, unknown>)?.url, 'url');
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message });
    return;
  }

  const searchId = (body as Record<string, unknown>)?.searchId;
  const searchIdStr = typeof searchId === 'string' && searchId.trim() ? searchId : undefined;

  const recipe = getRecipeForUrl(url);
  if (!recipe) {
    sendJSON(response, 400, { error: 'No recipe found for this URL' });
    return;
  }

  const database = getDb();

  startSSE(response);
  if (searchIdStr) {
    registerSearch(searchIdStr);
    request.on('close', () => cancelSearch(searchIdStr));
  }
  const isCancelled = () => (searchIdStr ? isSearchCancelled(searchIdStr) : false);
  const heartbeat = setInterval(() => {
    try {
      response.write(': heartbeat\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  try {
    await runQuickSearchForUrlAsync(
      url,
      recipe,
      database,
      (event) => {
        try {
          sse(response, event);
        } catch {
          /* client disconnected */
        }
      },
      isCancelled
    );
  } catch (err) {
    if (!isCancelled())
      try {
        sse(response, { type: 'error', message: (err as Error).message });
      } catch {
        /* ignore */
      }
  } finally {
    clearInterval(heartbeat);
    if (searchIdStr) cleanupSearch(searchIdStr);
    try {
      response.end();
    } catch {
      /* client already disconnected */
    }
  }
}
