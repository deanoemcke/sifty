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
// test fixture that triggers it needs this Show DOM present or getElement()
// throws. Append this markup and call populateShowControls() (from
// ./showDropdown) in beforeEach, alongside the rest of a test file's
// hand-built fixture.
//
// Both constants below are verbatim copies of the shells in index.html —
// testFixtures.test.ts asserts they stay structurally identical, so unit
// tests always exercise the DOM shape production actually renders.
export const SHOW_DROPDOWN_FIXTURE_HTML = `
  <div class="dropdown-control" id="showDropdown">
    <button id="showDropdownBtn" class="dropdown-trigger-btn" type="button" aria-haspopup="true" aria-expanded="false">
      <span class="dropdown-trigger-label">Show</span>
      <svg class="dropdown-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div id="showDropdownPanel" class="dropdown-panel hidden">
      <div class="dropdown-panel-header">Show</div>
      <div class="dropdown-panel-options" id="showDropdownOptions"></div>
      <div class="dropdown-panel-footer">
        <button id="showDropdownFooterBtn" class="dropdown-footer-btn" type="button">Show</button>
      </div>
    </div>
  </div>
`;

export const SORT_DROPDOWN_FIXTURE_HTML = `
  <div class="dropdown-control" id="sortDropdown">
    <button id="sortDropdownBtn" class="dropdown-trigger-btn" type="button" aria-haspopup="true" aria-expanded="false">
      <span class="dropdown-trigger-label">Sort results</span>
      <svg class="dropdown-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div id="sortDropdownPanel" class="dropdown-panel hidden">
      <div class="dropdown-panel-header">Sort by</div>
      <div class="dropdown-panel-options" id="sortDropdownOptions"></div>
      <div class="dropdown-panel-footer">
        <button id="sortDropdownFooterBtn" class="dropdown-footer-btn" type="button">Sort results</button>
      </div>
    </div>
  </div>
`;
