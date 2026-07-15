// Server-side only — /api/saved-searches route handlers (GET list, GET one, POST, DELETE).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseDiscoverInputs,
  requireArray,
  requireBoolean,
  requireString,
} from '../../lib/validate';
import {
  getDb,
  stmtDeleteSavedSearch,
  stmtGetSavedSearch,
  stmtGetSavedSearchByName,
  stmtInsertSavedSearch,
  stmtListSavedSearches,
  stmtUpdateSavedSearch,
  stmtUpdateSavedSearchAlert,
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
      shouldAlertOnNewListings: !!row.should_alert_on_new_listings,
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
        shouldAlertOnNewListings: !!row.should_alert_on_new_listings,
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
  let shouldAlertOnNewListings: boolean;
  try {
    name = requireString(rawBody.name, 'name');
    urls = requireArray(rawBody.urls, 'urls');
    discoverInputsSerialized = parseDiscoverInputs(rawBody.discoverInputs);
    shouldAlertOnNewListings =
      rawBody.shouldAlertOnNewListings === undefined
        ? false
        : requireBoolean(rawBody.shouldAlertOnNewListings, 'shouldAlertOnNewListings');
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message });
    return;
  }

  const aiFilter = rawBody.aiFilter;
  try {
    const database = getDb();
    const existing = stmtGetSavedSearchByName(database).get(name.trim());
    if (existing) {
      sendJSON(response, 409, {
        error: 'A saved search with this name already exists',
        existingId: existing.id,
      });
      return;
    }
    const id = crypto.randomUUID();
    stmtInsertSavedSearch(database).run(
      id,
      name.trim(),
      JSON.stringify(urls),
      discoverInputsSerialized,
      typeof aiFilter === 'string' && aiFilter.trim() ? aiFilter.trim() : null,
      Date.now(),
      shouldAlertOnNewListings ? 1 : 0
    );
    sendJSON(response, 200, { ok: true, id });
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
  }
}

export async function handlePatchSavedSearch(
  request: IncomingMessage,
  response: ServerResponse,
  id: string
): Promise<void> {
  const database = getDb();
  const row = stmtGetSavedSearch(database).get(id);
  if (!row) {
    sendJSON(response, 404, { error: 'Not found' });
    return;
  }

  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let shouldAlertOnNewListings: boolean;
  try {
    shouldAlertOnNewListings = requireBoolean(
      rawBody.shouldAlertOnNewListings,
      'shouldAlertOnNewListings'
    );
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message });
    return;
  }

  stmtUpdateSavedSearchAlert(database).run(shouldAlertOnNewListings ? 1 : 0, id);
  sendJSON(response, 200, { ok: true });
}

export async function handleUpdateSavedSearch(
  request: IncomingMessage,
  response: ServerResponse,
  id: string
): Promise<void> {
  const database = getDb();
  const row = stmtGetSavedSearch(database).get(id);
  if (!row) {
    sendJSON(response, 404, { error: 'Not found' });
    return;
  }

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
    stmtUpdateSavedSearch(database).run(
      name.trim(),
      JSON.stringify(urls),
      discoverInputsSerialized,
      typeof aiFilter === 'string' && aiFilter.trim() ? aiFilter.trim() : null,
      id
    );
    sendJSON(response, 200, { ok: true });
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
  }
}
