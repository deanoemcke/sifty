import { describe, expect, it } from 'vitest';
import { makeListing } from '../lib/testFixtures';
import { escapeSignalMarkdown, formatAlertMessage } from './signalMessage';

describe('formatAlertMessage', () => {
  it('composes the saved search name, bold title, source/location/price line, and url', () => {
    const listing = makeListing({
      source: 'trademe',
      title: 'Herman Miller Aeron, size B',
      price: 150,
      location: 'Wellington Central',
      url: 'https://www.trademe.co.nz/a/123456',
    });

    const message = formatAlertMessage('Chairs under $200', listing);

    expect(message).toBe(
      'Chairs under $200\n' +
        '**Herman Miller Aeron, size B**\n' +
        'Trade Me · Wellington Central · $150\n' +
        'https://www.trademe.co.nz/a/123456'
    );
  });

  it("renders 'Price on request' for a null price and the correct label per source", () => {
    const listing = makeListing({ source: 'facebook', price: null });

    const message = formatAlertMessage('My search', listing);

    expect(message).toContain('Facebook · Wellington · Price on request');
  });

  it('leaves the url untouched even if it contains markdown-special characters', () => {
    const listing = makeListing({ url: 'https://example.com/a_b*c?x=1~2' });

    const message = formatAlertMessage('My search', listing);

    expect(message.endsWith('https://example.com/a_b*c?x=1~2')).toBe(true);
  });

  it('escapes markdown-special characters in the title so they cannot break the bold wrapper', () => {
    const listing = makeListing({ title: 'Selling my **RARE** guitar' });

    const message = formatAlertMessage('My search', listing);

    // The only literal "**" pairs in the message must be the ones this
    // function itself added around the whole (escaped) title.
    expect(message.match(/\*\*/g)?.length).toBe(2);
  });

  it('does not let a leading/trailing * in the title merge with the bold wrapper into a *** run', () => {
    const listing = makeListing({ title: '*Rare* guitar' });

    const message = formatAlertMessage('My search', listing);

    expect(message).not.toMatch(/\*{3,}/);
  });
});

describe('escapeSignalMarkdown', () => {
  it('leaves plain text unchanged', () => {
    expect(escapeSignalMarkdown('Plain chair listing')).toBe('Plain chair listing');
  });

  it.each(['*', '_', '`', '~'])('strips adjacent pairs of %s entirely', (marker) => {
    const input = `a${marker}${marker}b`;
    const escaped = escapeSignalMarkdown(input);
    expect(escaped).not.toContain(marker);
  });

  it.each([
    '_',
    '`',
  ])('strips a single-character %s delimiter pair, not just spaces it apart', (marker) => {
    const input = `Cheap ${marker}car${marker} for sale`;
    const escaped = escapeSignalMarkdown(input);
    expect(escaped).not.toContain(marker);
  });
});
