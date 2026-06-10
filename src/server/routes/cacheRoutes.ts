// Server-side only — POST /api/cache/clear route handler.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb, stmtClearDetails, stmtClearSearch, stmtCountDetails, stmtCountSearch } from "../db";
import { readBody, sendJSON } from "../helpers";

export async function handleCacheClear(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const type = (body as Record<string, unknown>)?.type;

  if (type === "quick-search") {
    const database = getDb();
    const searchRow = stmtCountSearch(database).get();
    if (!searchRow) throw new Error("invariant: COUNT query returned no rows");
    const { n: totalCount } = searchRow;
    stmtClearSearch(database).run();
    console.log(`[cache] cleared quick search cache (${totalCount} entries)`);
    sendJSON(response, 200, { ok: true });
    return;
  }

  if (type === "deep-search") {
    const database = getDb();
    const detailRow = stmtCountDetails(database).get();
    if (!detailRow) throw new Error("invariant: COUNT query returned no rows");
    const { n: totalCount } = detailRow;
    stmtClearDetails(database).run();
    console.log(`[cache] cleared deep search cache (${totalCount} entries)`);
    sendJSON(response, 200, { ok: true });
    return;
  }

  sendJSON(response, 400, { error: "type must be quick-search or deep-search" });
}
