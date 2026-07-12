// Shared test fixtures for frontend specs. Consolidates what used to be five
// near-identical local `makeListing`/`makeListingItem` helpers (several of
// which used `as Listing` to bypass the compiler on incomplete literals) into
// one definition, so a future required field on `Listing`/`ListingItem`
// produces a compiler error here instead of silently untyped test data.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Listing } from '../lib/recipes/base';
import type { ListingItem } from './state';

// index.html is the real DOM initApp() is written against — reading it here
// (rather than hand-rolling a fixture) keeps test fixtures from drifting out
// of sync with the markup app.ts actually wires up in production.
export function loadIndexHtmlBodyFixture(): string {
  // Deliberately __dirname (not import.meta.url): under "@vitest-environment
  // jsdom" import.meta.url resolves to a fake http://localhost address rather
  // than a file:// URL, which fileURLToPath rejects.
  const indexHtmlPath = join(__dirname, '../../index.html');
  const indexHtml = readFileSync(indexHtmlPath, 'utf-8');
  const bodyMatch = indexHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) throw new Error('index.html fixture: <body> tag not found');
  return bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '');
}

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

export function makeListingItem(overrides: Partial<ListingItem> = {}): ListingItem {
  return {
    data: makeListing(),
    hasBeenDeepSearched: false,
    aiCheckedHash: null,
    aiFilterReason: null,
    ...overrides,
  };
}

// renderDerived() (resultsView.ts) always refreshes the Show dropdown, so any
// test fixture that triggers it needs the Show mount point present or
// getElement() throws. Append `<div id="showDropdown"></div>` and call
// populateShowControls() (from ./showDropdown) in beforeEach — it calls
// buildDropdownShell (dropdownPanel.ts) to fill the mount point, the same
// function production uses, so unit tests always exercise the real shell.
