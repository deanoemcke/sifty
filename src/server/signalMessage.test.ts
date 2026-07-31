import { describe, expect, it } from 'vitest';
import { makeListing } from '../lib/testFixtures';
import {
  escapeSignalMarkdown,
  formatAlertMessage,
  formatAlertSetupFailedMessage,
  formatAlertSetupSuccessMessage,
  formatSearchFailingMessage,
  formatSearchRecoveredMessage,
} from './signalMessage';

describe('formatAlertMessage', () => {
  it('composes a bold title, then a location/price line, then the url — no saved search name or source', () => {
    const listing = makeListing({
      source: 'trademe',
      title: 'Herman Miller Aeron, size B',
      price: 150,
      location: 'Wellington Central',
      url: 'https://www.trademe.co.nz/a/123456',
    });

    const message = formatAlertMessage(listing);

    expect(message).toBe(
      '**Herman Miller Aeron, size B**\n' +
        'Wellington Central · $150\n' +
        'https://www.trademe.co.nz/a/123456'
    );
  });

  it("renders 'Price on request' for a null price", () => {
    const listing = makeListing({ source: 'facebook', price: null });

    const message = formatAlertMessage(listing);

    expect(message).toContain('Wellington · Price on request');
  });

  it('strips a trailing ", New Zealand" from the location', () => {
    const listing = makeListing({ location: 'Titahi Bay, New Zealand' });

    const message = formatAlertMessage(listing);

    expect(message).toContain('Titahi Bay ·');
    expect(message).not.toContain('New Zealand');
  });

  it('strips a trailing ", NZ" from the location', () => {
    const listing = makeListing({ location: 'Auckland City, Auckland, NZ' });

    const message = formatAlertMessage(listing);

    expect(message).toContain('Auckland City ·');
    expect(message).not.toContain('NZ');
  });

  it('leaves a location with no country suffix unchanged', () => {
    const listing = makeListing({ location: 'Wellington Central' });

    const message = formatAlertMessage(listing);

    expect(message).toContain('Wellington Central ·');
  });

  it('leaves the url untouched even if it contains markdown-special characters', () => {
    const listing = makeListing({ url: 'https://example.com/a_b*c?x=1~2' });

    const message = formatAlertMessage(listing);

    expect(message.endsWith('https://example.com/a_b*c?x=1~2')).toBe(true);
  });

  it('escapes markdown-special characters in the title so they cannot break the bold wrapper', () => {
    const listing = makeListing({ title: 'Selling my **RARE** guitar' });

    const message = formatAlertMessage(listing);

    // The only literal "**" pairs in the message must be the ones this
    // function itself added around the whole (escaped) title.
    expect(message.match(/\*\*/g)?.length).toBe(2);
  });

  it('does not let a leading/trailing * in the title merge with the bold wrapper into a *** run', () => {
    const listing = makeListing({ title: '*Rare* guitar' });

    const message = formatAlertMessage(listing);

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

describe('formatSearchFailingMessage', () => {
  it('formats a single error as one concise "Scrape error - <name>. <error>" line', () => {
    const message = formatSearchFailingMessage('My search', ['Facebook requires login.']);

    expect(message).toBe('Scrape error - My search. Facebook requires login.');
  });

  it('omits everything but the name and error — no header, no framing text', () => {
    const message = formatSearchFailingMessage('My search', ['some reason']);

    expect(message).not.toContain('discarded');
    expect(message).not.toContain('Some results');
    expect(message).not.toContain('trusted');
  });

  it('emits one deduplicated line per distinct error', () => {
    const message = formatSearchFailingMessage('My search', ['reason A', 'reason A', 'reason B']);

    expect(message.split('\n')).toEqual([
      'Scrape error - My search. reason A',
      'Scrape error - My search. reason B',
    ]);
  });

  it('escapes markdown-special characters in the saved search name', () => {
    const message = formatSearchFailingMessage('**Sneaky** search', ['reason']);

    expect(message).not.toMatch(/[*_`~]/);
  });

  it('escapes markdown-special characters within the error', () => {
    const message = formatSearchFailingMessage('S', ['contains *asterisks* and _underscores_']);

    expect(message).not.toMatch(/[*_`~]/);
    expect(message).toContain('contains asterisks and underscores');
  });
});

describe('formatSearchRecoveredMessage', () => {
  it('names the saved search as working again', () => {
    const message = formatSearchRecoveredMessage('My search');

    expect(message).toContain('My search');
    expect(message).toContain('working again');
  });

  it('escapes markdown-special characters in the saved search name', () => {
    const message = formatSearchRecoveredMessage('**Sneaky** search');

    expect(message).not.toMatch(/[*_`~]/);
  });
});

describe('formatAlertSetupSuccessMessage', () => {
  it('names the search and reports the baseline listing count', () => {
    const message = formatAlertSetupSuccessMessage('My search', 3);

    expect(message).toBe(
      '✅ Alerts set up for "My search" — recorded 3 existing listing(s) as the starting point. ' +
        "You'll be notified about new ones from here."
    );
  });

  it('renders a zero baseline count rather than omitting it', () => {
    const message = formatAlertSetupSuccessMessage('My search', 0);

    expect(message).toContain('recorded 0 existing listing(s)');
  });

  it('escapes markdown-special characters in the saved search name', () => {
    const message = formatAlertSetupSuccessMessage('**Sneaky** search', 3);

    expect(message).not.toMatch(/[*_`~]/);
  });
});

describe('formatAlertSetupFailedMessage', () => {
  it('formats a single error as a header line plus one "- <error>" line', () => {
    const message = formatAlertSetupFailedMessage('My search', ['Facebook requires login.']);

    expect(message).toBe('⚠️ Couldn\'t set up alerts for "My search":\n- Facebook requires login.');
  });

  it('emits one deduplicated line per distinct error', () => {
    const message = formatAlertSetupFailedMessage('My search', [
      'reason A',
      'reason A',
      'reason B',
    ]);

    expect(message.split('\n')).toEqual([
      '⚠️ Couldn\'t set up alerts for "My search":',
      '- reason A',
      '- reason B',
    ]);
  });

  it('escapes markdown-special characters in the saved search name', () => {
    const message = formatAlertSetupFailedMessage('**Sneaky** search', ['reason']);

    expect(message).not.toMatch(/[*_`~]/);
  });

  it('escapes markdown-special characters within each error', () => {
    const message = formatAlertSetupFailedMessage('S', ['contains *asterisks* and _underscores_']);

    expect(message).not.toMatch(/[*_`~]/);
    expect(message).toContain('contains asterisks and underscores');
  });
});
