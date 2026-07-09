// Region data service — loads and caches the regions.json asset.
// Imported by recipes (e.g. facebook.ts) and re-exported by the regions route.

import fs from 'node:fs';
import path from 'node:path';

export type RegionEntry = { name: string; tradeMeRegionId: number; facebookLocation?: string };

let _regions: RegionEntry[] | null = null;

export function getRegions(): RegionEntry[] {
  if (_regions) return _regions;
  _regions = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../assets/regions.json'), 'utf8')
  ) as RegionEntry[];
  return _regions;
}
