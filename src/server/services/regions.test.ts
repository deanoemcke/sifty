import { describe, expect, it } from 'vitest';
import { getRegions } from './regions';

describe('getRegions Facebook location IDs', () => {
  it('gives every region a numeric Facebook location ID', () => {
    for (const region of getRegions()) {
      expect(region.facebookLocationId, region.name).toMatch(/^\d{10,}$/);
    }
  });

  it('gives every region a distinct Facebook location ID', () => {
    const locationIds = getRegions().map((region) => region.facebookLocationId);
    expect(new Set(locationIds).size).toBe(locationIds.length);
  });
});
