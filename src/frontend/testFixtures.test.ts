// @vitest-environment jsdom
// Drift guard: the dropdown fixture constants exist so unit tests exercise the
// same shell markup production renders. These tests compare each constant
// against the matching element in index.html, so a change to either side fails
// here instead of leaving unit suites green against a stale DOM shape.
import { describe, expect, it } from 'vitest';
import {
  loadIndexHtmlBodyFixture,
  SHOW_DROPDOWN_FIXTURE_HTML,
  SORT_DROPDOWN_FIXTURE_HTML,
} from './testFixtures';

// Collapses formatting-only whitespace (indentation, line breaks between tags)
// so the comparison is structural rather than sensitive to template-literal
// indentation depth.
function normalizeMarkup(html: string): string {
  return html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
}

function getIndexHtmlElementMarkup(elementId: string): string {
  document.body.innerHTML = loadIndexHtmlBodyFixture();
  const element = document.getElementById(elementId);
  if (!element) throw new Error(`#${elementId} not found in index.html`);
  return element.outerHTML;
}

function getFixtureElementMarkup(fixtureHtml: string, elementId: string): string {
  document.body.innerHTML = fixtureHtml;
  const element = document.getElementById(elementId);
  if (!element) throw new Error(`#${elementId} not found in fixture constant`);
  return element.outerHTML;
}

describe('dropdown fixture constants match the production shell in index.html', () => {
  it('SHOW_DROPDOWN_FIXTURE_HTML matches #showDropdown', () => {
    const productionMarkup = getIndexHtmlElementMarkup('showDropdown');
    const fixtureMarkup = getFixtureElementMarkup(SHOW_DROPDOWN_FIXTURE_HTML, 'showDropdown');
    expect(normalizeMarkup(fixtureMarkup)).toBe(normalizeMarkup(productionMarkup));
  });

  it('SORT_DROPDOWN_FIXTURE_HTML matches #sortDropdown', () => {
    const productionMarkup = getIndexHtmlElementMarkup('sortDropdown');
    const fixtureMarkup = getFixtureElementMarkup(SORT_DROPDOWN_FIXTURE_HTML, 'sortDropdown');
    expect(normalizeMarkup(fixtureMarkup)).toBe(normalizeMarkup(productionMarkup));
  });
});
