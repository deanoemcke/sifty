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

  // The external <label for="…"> sits outside the dropdown root, but the
  // browser forwards its click to the trigger button. If handleOutsideClick
  // treated the label as outside, it would close the panel a beat before the
  // forwarded click toggles it straight back open — so the label could open
  // the panel but never close it.
  it('leaves the panel open when the target is a label for the open trigger', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    const externalLabel = document.createElement('label');
    externalLabel.htmlFor = a.trigger.id;
    document.body.appendChild(externalLabel);
    handleOutsideClick(externalLabel);
    expect(a.panel.classList.contains('hidden')).toBe(false);
  });

  it('treats a click on an element nested inside the trigger label as inside', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    const externalLabel = document.createElement('label');
    externalLabel.htmlFor = a.trigger.id;
    const nestedSpan = document.createElement('span');
    externalLabel.appendChild(nestedSpan);
    document.body.appendChild(externalLabel);
    handleOutsideClick(nestedSpan);
    expect(a.panel.classList.contains('hidden')).toBe(false);
  });

  it('closes the panel when the target is a label for an unrelated control', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    const unrelatedLabel = document.createElement('label');
    unrelatedLabel.htmlFor = 'someUnrelatedControl';
    document.body.appendChild(unrelatedLabel);
    handleOutsideClick(unrelatedLabel);
    expect(a.panel.classList.contains('hidden')).toBe(true);
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

describe('focus restore on close', () => {
  function addRadioToPanel(elements: DropdownElements): HTMLInputElement {
    const radio = document.createElement('input');
    radio.type = 'radio';
    elements.panel.appendChild(radio);
    return radio;
  }

  it('restores focus to the trigger when Escape closes a panel containing focus', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    addRadioToPanel(a).focus();
    handleEscapeKey('Escape');
    expect(document.activeElement).toBe(a.trigger);
  });

  it('restores focus to the trigger when closing directly while focus is inside the panel', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    addRadioToPanel(a).focus();
    closeDropdownPanel(a);
    expect(document.activeElement).toBe(a.trigger);
  });

  it('does not steal focus on outside-click close when focus is already outside the panel', () => {
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    const outsideButton = document.createElement('button');
    document.body.appendChild(outsideButton);
    outsideButton.focus();
    handleOutsideClick(outsideButton);
    expect(a.panel.classList.contains('hidden')).toBe(true);
    expect(document.activeElement).toBe(outsideButton);
  });

  it('restores focus to the first trigger when opening a second dropdown while focus is inside the first panel', () => {
    const a = buildDropdownFixture('a');
    const b = buildDropdownFixture('b');
    openDropdownPanel(a);
    addRadioToPanel(a).focus();
    openDropdownPanel(b);
    expect(document.activeElement).toBe(a.trigger);
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
