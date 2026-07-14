// Shared test fixtures usable from both frontend and server specs — kept
// dependency-free (only the pure `Listing` type) so it can be imported from
// either side without pulling in DOM or Node-only code.
import type { Listing } from './recipes/base';

export function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: 'trademe',
    title: 'Test listing',
    price: 100,
    location: 'Wellington',
    url: 'https://example.com/listing/1',
    isAuction: false,
    relevance: 0,
    ...overrides,
  };
}
