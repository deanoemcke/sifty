// Server-side only — /api/saved-searches route handlers (GET list, GET one, POST, DELETE).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseDiscoverInputs, requireArray, requireString } from '../../lib/validate';
import {
  getDb,
  stmtDeleteSavedSearch,
  stmtGetSavedSearch,
  stmtInsertSavedSearch,
  stmtListSavedSearches,
} from '../db';
import { readBody, sendJSON } from '../helpers';

export function handleListSavedSearches(_req: unknown, response: ServerResponse): void {
  const database = getDb();
  const rows = stmtListSavedSearches(database).all();
  try {
    const searches = rows.map((row) => ({
      id: row.id,
      name: row.name,
      urls: JSON.parse(row.urls) as string[],
      discoverInputs: row.discover_inputs ? JSON.parse(row.discover_inputs) : null,
      aiFilter: row.ai_filter,
      createdAt: row.created_at,
    }));
    sendJSON(response, 200, { searches });
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
  }
}

export function handleGetSavedSearch(_req: unknown, response: ServerResponse, id: string): void {
  const database = getDb();
  const row = stmtGetSavedSearch(database).get(id);
  if (!row) {
    sendJSON(response, 404, { error: 'Not found' });
    return;
  }
  try {
    sendJSON(response, 200, {
      search: {
        id: row.id,
        name: row.name,
        urls: JSON.parse(row.urls),
        discoverInputs: row.discover_inputs ? JSON.parse(row.discover_inputs) : null,
        aiFilter: row.ai_filter,
        createdAt: row.created_at,
      },
    });
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
  }
}

export function handleDeleteSavedSearch(_req: unknown, response: ServerResponse, id: string): void {
  const database = getDb();
  const row = stmtGetSavedSearch(database).get(id);
  if (!row) {
    sendJSON(response, 404, { error: 'Not found' });
    return;
  }
  stmtDeleteSavedSearch(database).run(id);
  sendJSON(response, 200, { ok: true });
}

export async function handleCreateSavedSearch(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let name: string;
  let urls: unknown[];
  let discoverInputsSerialized: string | null;
  try {
    name = requireString(rawBody.name, 'name');
    urls = requireArray(rawBody.urls, 'urls');
    discoverInputsSerialized = parseDiscoverInputs(rawBody.discoverInputs);
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message });
    return;
  }

  const aiFilter = rawBody.aiFilter;
  try {
    const database = getDb();
    const id = crypto.randomUUID();
    stmtInsertSavedSearch(database).run(
      id,
      name.trim(),
      JSON.stringify(urls),
      discoverInputsSerialized,
      typeof aiFilter === 'string' && aiFilter.trim() ? aiFilter.trim() : null,
      Date.now()
    );
    sendJSON(response, 200, { ok: true, id });
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
  }
}
