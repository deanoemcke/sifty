// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeDropdownPanel,
  type DropdownElements,
  getDropdownElements,
  handleEscapeKey,
  handleOutsideClick,
  openDropdownPanel,
  resetOpenDropdown,
  setDropdownLabel,
  toggleDropdownPanel,
} from './dropdownPanel';

function buildDropdownFixture(prefix: string): DropdownElements {
  const root = document.createElement('div');
  root.id = `${prefix}Root`;
  root.innerHTML = `
    <button id="${prefix}Btn" type="button" aria-expanded="false">
      <span class="dropdown-trigger-label">${prefix}</span>
      <svg class="dropdown-caret"></svg>
    </button>
    <div id="${prefix}Panel" class="hidden"></div>
    <button id="${prefix}FooterBtn" type="button">${prefix}</button>
  `;
  document.body.appendChild(root);
  return getDropdownElements({
    root: `${prefix}Root`,
    trigger: `${prefix}Btn`,
    panel: `${prefix}Panel`,
    footer: `${prefix}FooterBtn`,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetOpenDropdown();
});

describe('openDropdownPanel / closeDropdownPanel / toggleDropdownPanel', () => {
  it('open unhides the panel and sets aria-expanded true', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    expect(a.panel.classList.contains('hidden')).toBe(false);
    expect(a.trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('close hides the panel and sets aria-expanded false', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    closeDropdownPanel(a);
    expect(a.panel.classList.contains('hidden')).toBe(true);
    expect(a.trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('toggle flips open then closed', () => {
    const a = buildDropdownFixture('a');
    toggleDropdownPanel(a);
    expect(a.panel.classList.contains('hidden')).toBe(false);
    toggleDropdownPanel(a);
    expect(a.panel.classList.contains('hidden')).toBe(true);
  });

  it('opening a second dropdown closes the first', () => {
    const a = buildDropdownFixture('a');
    const b = buildDropdownFixture('b');
    openDropdownPanel(a);
    openDropdownPanel(b);
    expect(a.panel.classList.contains('hidden')).toBe(true);
    expect(a.trigger.getAttribute('aria-expanded')).toBe('false');
    expect(b.panel.classList.contains('hidden')).toBe(false);
  });
});

describe('handleOutsideClick', () => {
  it('closes the open dropdown when the click target is outside its root', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    const outsideNode = document.createElement('div');
    document.body.appendChild(outsideNode);
    handleOutsideClick(outsideNode);
    expect(a.panel.classList.contains('hidden')).toBe(true);
  });

  it('does nothing when the click target is inside the open root', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    handleOutsideClick(a.panel);
    expect(a.panel.classList.contains('hidden')).toBe(false);
  });

  it('does nothing when no dropdown is open', () => {
    buildDropdownFixture('a');
    const outsideNode = document.createElement('div');
    document.body.appendChild(outsideNode);
    expect(() => handleOutsideClick(outsideNode)).not.toThrow();
  });
});

describe('handleEscapeKey', () => {
  it('closes the open dropdown on Escape', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    handleEscapeKey('Escape');
    expect(a.panel.classList.contains('hidden')).toBe(true);
  });

  it('ignores other keys', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    handleEscapeKey('Enter');
    expect(a.panel.classList.contains('hidden')).toBe(false);
  });

  it('does nothing when no dropdown is open', () => {
    buildDropdownFixture('a');
    expect(() => handleEscapeKey('Escape')).not.toThrow();
  });
});

describe('setDropdownLabel', () => {
  it('writes only the trigger label span text and the footer text, leaving siblings intact', () => {
    const a = buildDropdownFixture('a');
    setDropdownLabel(a, 'Show 47 results');
    expect(a.trigger.querySelector('.dropdown-trigger-label')?.textContent).toBe('Show 47 results');
    expect(a.trigger.querySelector('.dropdown-caret')).not.toBeNull();
    expect(a.footer.textContent).toBe('Show 47 results');
  });
});
