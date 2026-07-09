// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getElement, requireChild } from './domUtils';

describe('requireChild', () => {
  it('returns the matching child element', () => {
    const parent = document.createElement('div');
    const child = document.createElement('span');
    child.className = 'target';
    parent.appendChild(child);
    expect(requireChild(parent, '.target')).toBe(child);
  });

  it('throws when no child matches the selector', () => {
    const parent = document.createElement('div');
    expect(() => requireChild(parent, '.missing')).toThrow('Element ".missing" not found');
  });
});

describe('getElement', () => {
  it('returns the element with the given id', () => {
    const el = document.createElement('div');
    el.id = 'test-el';
    document.body.appendChild(el);
    expect(getElement('test-el')).toBe(el);
    el.remove();
  });

  it('throws when no element with the given id exists', () => {
    expect(() => getElement('no-such-id')).toThrow('Element #no-such-id not found');
  });
});
