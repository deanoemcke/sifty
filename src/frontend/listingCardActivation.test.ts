// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  applyListingCardAccessibility,
  handleListingCardKeydown,
  isExternalLinkTarget,
  resolveListingCardOpenArea,
} from './listingCardActivation';

function buildListingCard(): { card: HTMLElement; inner: HTMLElement } {
  const card = document.createElement('div');
  card.className = 'listing-card';
  const inner = document.createElement('div');
  inner.className = 'listing-title';
  card.appendChild(inner);
  document.body.appendChild(card);
  return { card, inner };
}

function dispatchKeydown(target: HTMLElement, key: string): KeyboardEvent {
  const keyboardEvent = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(keyboardEvent);
  return keyboardEvent;
}

describe('applyListingCardAccessibility', () => {
  it('makes the card focusable with button semantics and a label', () => {
    const { card } = buildListingCard();
    applyListingCardAccessibility(card, 'Vintage road bike');
    expect(card.tabIndex).toBe(0);
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('aria-label')).toBe('Vintage road bike');
  });
});

describe('handleListingCardKeydown', () => {
  it('opens the card on Enter', () => {
    const { card } = buildListingCard();
    const openCard = vi.fn();
    card.addEventListener('keydown', (keyboardEvent) =>
      handleListingCardKeydown(keyboardEvent, openCard)
    );
    dispatchKeydown(card, 'Enter');
    expect(openCard).toHaveBeenCalledWith(card);
  });

  it('opens the card on Space and prevents the page-scroll default', () => {
    const { card } = buildListingCard();
    const openCard = vi.fn();
    card.addEventListener('keydown', (keyboardEvent) =>
      handleListingCardKeydown(keyboardEvent, openCard)
    );
    const keyboardEvent = dispatchKeydown(card, ' ');
    expect(openCard).toHaveBeenCalledWith(card);
    expect(keyboardEvent.defaultPrevented).toBe(true);
  });

  it('resolves the card from a descendant target', () => {
    const { card, inner } = buildListingCard();
    const openCard = vi.fn();
    card.addEventListener('keydown', (keyboardEvent) =>
      handleListingCardKeydown(keyboardEvent, openCard)
    );
    dispatchKeydown(inner, 'Enter');
    expect(openCard).toHaveBeenCalledWith(card);
  });

  it('ignores non-activation keys', () => {
    const { card } = buildListingCard();
    const openCard = vi.fn();
    card.addEventListener('keydown', (keyboardEvent) =>
      handleListingCardKeydown(keyboardEvent, openCard)
    );
    dispatchKeydown(card, 'a');
    expect(openCard).not.toHaveBeenCalled();
  });

  it('ignores keydown events outside any listing card', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const openCard = vi.fn();
    outside.addEventListener('keydown', (keyboardEvent) =>
      handleListingCardKeydown(keyboardEvent, openCard)
    );
    dispatchKeydown(outside, 'Enter');
    expect(openCard).not.toHaveBeenCalled();
  });
});

describe('isExternalLinkTarget', () => {
  it('returns true for the external-link button and its descendants', () => {
    const link = document.createElement('a');
    link.className = 'listing-external-link-btn';
    const icon = document.createElement('span');
    link.appendChild(icon);
    document.body.appendChild(link);
    expect(isExternalLinkTarget(link)).toBe(true);
    expect(isExternalLinkTarget(icon)).toBe(true);
  });

  it('returns false for a target outside the external-link button', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    expect(isExternalLinkTarget(outside)).toBe(false);
  });
});

describe('resolveListingCardOpenArea', () => {
  // The external-link button is rendered as a sibling of .listing-open-area
  // in production (never nested inside it), but resolveListingCardOpenArea
  // still guards against it explicitly via the shared isExternalLinkTarget
  // predicate, so it stays correct regardless of where the button lives.
  function buildOpenAreaWithSiblingExternalLink(): { openArea: HTMLElement; link: HTMLElement } {
    const wrapper = document.createElement('div');
    const openArea = document.createElement('div');
    openArea.className = 'listing-open-area';
    const link = document.createElement('a');
    link.className = 'listing-external-link-btn';
    wrapper.appendChild(openArea);
    wrapper.appendChild(link);
    document.body.appendChild(wrapper);
    return { openArea, link };
  }

  it('returns the open area for a click inside it', () => {
    const { openArea } = buildOpenAreaWithSiblingExternalLink();
    expect(resolveListingCardOpenArea(openArea)).toBe(openArea);
  });

  it('returns null when the click originated on the external-link button', () => {
    const { link } = buildOpenAreaWithSiblingExternalLink();
    expect(resolveListingCardOpenArea(link)).toBeNull();
  });

  it('returns null when the click is outside any open area', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    expect(resolveListingCardOpenArea(outside)).toBeNull();
  });
});
