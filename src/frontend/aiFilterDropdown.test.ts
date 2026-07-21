// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeAiFilterDropdownPanel,
  populateAiFilterDropdown,
  toggleAiFilterDropdownPanel,
} from './aiFilterDropdown';
import { handleOutsideClick, openDropdownPanel, resetOpenDropdown } from './dropdownPanel';

beforeEach(() => {
  resetOpenDropdown();
  document.body.innerHTML = `
    <div id="aiFilterDropdown"></div>
    <div id="aiFilterPanel">
      <textarea id="aiFilter"></textarea>
      <button id="aiFilterBtn" type="button">Filter</button>
    </div>
  `;
  populateAiFilterDropdown();
});

describe('populateAiFilterDropdown', () => {
  it('builds a trigger button wired to the panel', () => {
    const trigger = document.getElementById('aiFilterDropdownBtn');
    expect(trigger?.tagName).toBe('BUTTON');
    expect(trigger?.getAttribute('aria-controls')).toBe('aiFilterPanel');
  });

  it('starts the panel collapsed', () => {
    expect(
      document.getElementById('aiFilterPanel')?.classList.contains('ai-filter-panel-collapsed')
    ).toBe(true);
  });

  it('does not add the global hidden class to the panel', () => {
    expect(document.getElementById('aiFilterPanel')?.classList.contains('hidden')).toBe(false);
  });
});

describe('toggleAiFilterDropdownPanel / closeAiFilterDropdownPanel', () => {
  it('toggle opens then closes the panel', () => {
    const panel = document.getElementById('aiFilterPanel') as HTMLElement;
    toggleAiFilterDropdownPanel();
    expect(panel.classList.contains('ai-filter-panel-collapsed')).toBe(false);
    toggleAiFilterDropdownPanel();
    expect(panel.classList.contains('ai-filter-panel-collapsed')).toBe(true);
  });

  it('close collapses an open panel', () => {
    const panel = document.getElementById('aiFilterPanel') as HTMLElement;
    toggleAiFilterDropdownPanel();
    closeAiFilterDropdownPanel();
    expect(panel.classList.contains('ai-filter-panel-collapsed')).toBe(true);
  });

  it('is safe to call close when the panel is already collapsed', () => {
    expect(() => closeAiFilterDropdownPanel()).not.toThrow();
  });
});

describe('interop with other dropdowns sharing dropdownPanel.ts state', () => {
  it('opening another dropdown auto-closes the AI filter panel', () => {
    const panel = document.getElementById('aiFilterPanel') as HTMLElement;
    toggleAiFilterDropdownPanel();
    expect(panel.classList.contains('ai-filter-panel-collapsed')).toBe(false);

    const otherRoot = document.createElement('div');
    otherRoot.innerHTML = `
      <button id="otherBtn" type="button" aria-expanded="false"></button>
      <div id="otherPanel" class="hidden"></div>
      <button id="otherFooterBtn" type="button"></button>
    `;
    document.body.appendChild(otherRoot);
    const other = {
      root: otherRoot,
      trigger: document.getElementById('otherBtn') as HTMLButtonElement,
      panel: document.getElementById('otherPanel') as HTMLElement,
      footer: document.getElementById('otherFooterBtn') as HTMLButtonElement,
      closedClass: 'hidden',
    };
    openDropdownPanel(other);
    expect(panel.classList.contains('ai-filter-panel-collapsed')).toBe(true);
  });

  it('outside click closes the open AI filter panel', () => {
    const panel = document.getElementById('aiFilterPanel') as HTMLElement;
    toggleAiFilterDropdownPanel();
    const outsideNode = document.createElement('div');
    document.body.appendChild(outsideNode);
    handleOutsideClick(outsideNode);
    expect(panel.classList.contains('ai-filter-panel-collapsed')).toBe(true);
  });

  // The AI filter's trigger (#aiFilterDropdown) and panel (#aiFilterPanel)
  // are separate top-level elements rather than sharing one wrapping root
  // like Show/Sort do — a click on the panel's own content (the textarea,
  // its label, ...) must not be mistaken for a click outside the dropdown.
  it('a click inside the panel content does not close the panel', () => {
    const panel = document.getElementById('aiFilterPanel') as HTMLElement;
    toggleAiFilterDropdownPanel();
    handleOutsideClick(document.getElementById('aiFilter') as HTMLElement);
    expect(panel.classList.contains('ai-filter-panel-collapsed')).toBe(false);
  });
});
