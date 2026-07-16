// Server-side only — POST /api/cache/clear route handler.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getDb,
  stmtClearDetails,
  stmtClearDetailsForUrl,
  stmtClearSearch,
  stmtClearSearchForUrl,
} from '../db';
import { readBody, sendJSON } from '../helpers';

export async function handleCacheClear(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const type = (body as Record<string, unknown>)?.type;
  const url = (body as Record<string, unknown>)?.url;
  const scopedUrl = typeof url === 'string' && url.length > 0 ? url : null;

  if (type === 'quick-search') {
    const database = getDb();
    const { changes } = scopedUrl
      ? stmtClearSearchForUrl(database).run(scopedUrl)
      : stmtClearSearch(database).run();
    console.log(
      scopedUrl
        ? `[cache] cleared quick search cache for ${scopedUrl} (${changes} entries)`
        : `[cache] cleared quick search cache (${changes} entries)`
    );
    sendJSON(response, 200, { ok: true });
    return;
  }

  if (type === 'deep-search') {
    const database = getDb();
    const { changes } = scopedUrl
      ? stmtClearDetailsForUrl(database).run(scopedUrl)
      : stmtClearDetails(database).run();
    console.log(
      scopedUrl
        ? `[cache] cleared deep search cache for ${scopedUrl} (${changes} entries)`
        : `[cache] cleared deep search cache (${changes} entries)`
    );
    sendJSON(response, 200, { ok: true });
    return;
  }

  sendJSON(response, 400, { error: 'type must be quick-search or deep-search' });
}
