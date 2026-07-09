// Server-side only — GET /api/regions route handler.

import type { ServerResponse } from 'node:http';
import { sendJSON } from '../helpers';
import { getRegions } from '../services/regions';

export type { RegionEntry } from '../services/regions';
export { getRegions } from '../services/regions';

export function handleRegions(_req: unknown, response: ServerResponse): void {
  const regions = getRegions();
  sendJSON(
    response,
    200,
    regions.map((region) => ({ value: String(region.tradeMeRegionId), display: region.name }))
  );
}
