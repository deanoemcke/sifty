// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDropdownShell,
  closeDropdownPanel,
  type DropdownElements,
  getDropdownElements,
  handleDropdownPopState,
  handleDropdownTabKey,
  handleEscapeKey,
  handleOutsideClick,
  openDropdownPanel,
  resetOpenDropdown,
  setDropdownLabel,
  toggleDropdownPanel,
} from './dropdownPanel';

// Mirrors dropdownPanel.ts's MOBILE_SHEET_MEDIA_QUERY. Kept as a literal
// rather than imported so this stub only matches the one query it's meant to
// simulate, not whatever the production module happens to check.
const MOBILE_SHEET_MEDIA_QUERY = '(max-width: 640px)';

// Stubs window.matchMedia, which jsdom doesn't implement, so tests can
// exercise the mobile full-screen-sheet branch of dropdownPanel.ts without a
// real viewport. Only reports a match for the mobile breakpoint query itself
// — any other query (e.g. prefers-reduced-motion) always reports no match,
// so this stub can't silently affect unrelated code that checks a different
// media query. Returns a restore function to undo the stub.
function stubMobileMatchMedia(matches: boolean): () => void {
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query === MOBILE_SHEET_MEDIA_QUERY && matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  return () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  };
}

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
    trigger: `${prefix}Btn`,
    panel: `${prefix}Panel`,
    footer: `${prefix}FooterBtn`,
  });
}

describe('stubMobileMatchMedia', () => {
  it('only reports a match for the mobile breakpoint query, not unrelated media queries', () => {
    const restore = stubMobileMatchMedia(true);
    expect(window.matchMedia(MOBILE_SHEET_MEDIA_QUERY).matches).toBe(true);
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(false);
    restore();
  });
});

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  resetOpenDropdown();
  history.replaceState(null, '');
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe('custom closedClass', () => {
  function buildDropdownFixtureWithClosedClass(
    prefix: string,
    closedClass: string
  ): DropdownElements {
    const root = document.createElement('div');
    root.id = `${prefix}Root`;
    root.innerHTML = `
      <button id="${prefix}Btn" type="button" aria-expanded="false">
        <span class="dropdown-trigger-label">${prefix}</span>
        <svg class="dropdown-caret"></svg>
      </button>
      <div id="${prefix}Panel" class="${closedClass}"></div>
      <button id="${prefix}FooterBtn" type="button">${prefix}</button>
    `;
    document.body.appendChild(root);
    return getDropdownElements({
      trigger: `${prefix}Btn`,
      panel: `${prefix}Panel`,
      footer: `${prefix}FooterBtn`,
      closedClass,
    });
  }

  it('opens/closes by toggling the given class instead of "hidden"', () => {
    const a = buildDropdownFixtureWithClosedClass('a', 'ai-filter-panel-collapsed');
    openDropdownPanel(a);
    expect(a.panel.classList.contains('ai-filter-panel-collapsed')).toBe(false);
    closeDropdownPanel(a);
    expect(a.panel.classList.contains('ai-filter-panel-collapsed')).toBe(true);
  });

  it('closing one dropdown with a custom closedClass still closes a differently-classed open dropdown', () => {
    const a = buildDropdownFixtureWithClosedClass('a', 'ai-filter-panel-collapsed');
    const b = buildDropdownFixture('b');
    openDropdownPanel(a);
    openDropdownPanel(b);
    expect(a.panel.classList.contains('ai-filter-panel-collapsed')).toBe(true);
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

describe('buildDropdownShell', () => {
  const ids = {
    root: 'shellRoot',
    trigger: 'shellBtn',
    panel: 'shellPanel',
    options: 'shellOptions',
    footer: 'shellFooterBtn',
  };

  const ICON = '<svg class="test-icon"></svg>';

  function buildShellFixture(): HTMLElement {
    const root = document.createElement('div');
    root.id = ids.root;
    document.body.appendChild(root);
    buildDropdownShell(ids, 'Show', ICON);
    return root;
  }

  it('builds a trigger button, panel, options container and footer button with matching ids', () => {
    buildShellFixture();
    expect(document.getElementById(ids.trigger)?.tagName).toBe('BUTTON');
    expect(document.getElementById(ids.panel)?.classList.contains('dropdown-panel')).toBe(true);
    expect(document.getElementById(ids.panel)?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById(ids.options)?.classList.contains('dropdown-panel-options')).toBe(
      true
    );
    expect(document.getElementById(ids.footer)?.tagName).toBe('BUTTON');
  });

  it('seeds the trigger label, panel header and footer text with the given title', () => {
    buildShellFixture();
    expect(
      document.getElementById(ids.trigger)?.querySelector('.dropdown-trigger-label')?.textContent
    ).toBe('Show');
    expect(document.querySelector('.dropdown-panel-header')?.textContent).toBe('Show');
    expect(document.getElementById(ids.footer)?.textContent).toBe('Show');
  });

  it('sets aria-haspopup/aria-expanded on the trigger', () => {
    buildShellFixture();
    const trigger = document.getElementById(ids.trigger);
    expect(trigger?.getAttribute('aria-haspopup')).toBe('true');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('points the trigger aria-controls at the panel id', () => {
    buildShellFixture();
    expect(document.getElementById(ids.trigger)?.getAttribute('aria-controls')).toBe(ids.panel);
  });

  it('gives the panel role="group" and an aria-label matching the title', () => {
    buildShellFixture();
    const panel = document.getElementById(ids.panel);
    expect(panel?.getAttribute('role')).toBe('group');
    expect(panel?.getAttribute('aria-label')).toBe('Show');
  });

  it('gives the trigger a single caret icon carrying the dropdown-caret class', () => {
    buildShellFixture();
    const carets = document.getElementById(ids.trigger)?.querySelectorAll('svg.dropdown-caret');
    expect(carets).toHaveLength(1);
  });

  it('is safe to call repeatedly on the same root (rebuilds the shell)', () => {
    const root = buildShellFixture();
    buildDropdownShell(ids, 'Show', ICON);
    expect(root.querySelectorAll(`#${ids.trigger}`)).toHaveLength(1);
  });

  it('renders the given icon inside a dropdown-trigger-icon span', () => {
    buildShellFixture();
    const iconSpan = document.getElementById(ids.trigger)?.querySelector('.dropdown-trigger-icon');
    expect(iconSpan?.innerHTML).toBe(ICON);
  });
});

describe('setDropdownLabel', () => {
  it('writes the trigger label span text and a separate footer text, leaving siblings intact', () => {
    const a = buildDropdownFixture('a');
    setDropdownLabel(a, '47 results', 'Show 47 results');
    expect(a.trigger.querySelector('.dropdown-trigger-label')?.textContent).toBe('47 results');
    expect(a.trigger.querySelector('.dropdown-caret')).not.toBeNull();
    expect(a.footer.textContent).toBe('Show 47 results');
  });
});

describe('scroll lock (mobile full-screen sheet)', () => {
  it('locks body scroll when opening while the mobile breakpoint is active', () => {
    const restore = stubMobileMatchMedia(true);
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    expect(document.body.classList.contains('scroll-locked')).toBe(true);
    restore();
  });

  it('does not lock body scroll when opening at desktop width', () => {
    const restore = stubMobileMatchMedia(false);
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    expect(document.body.classList.contains('scroll-locked')).toBe(false);
    restore();
  });

  it('unlocks body scroll when the panel closes', () => {
    const restore = stubMobileMatchMedia(true);
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    closeDropdownPanel(a);
    expect(document.body.classList.contains('scroll-locked')).toBe(false);
    restore();
  });
});

describe('back-button history (mobile full-screen sheet)', () => {
  it('pushes a history entry when opening while the mobile breakpoint is active', () => {
    const restore = stubMobileMatchMedia(true);
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    expect((history.state as { siftyModalOpen?: boolean } | null)?.siftyModalOpen).toBe(true);
    restore();
  });

  it('does not push a history entry when opening at desktop width', () => {
    const restore = stubMobileMatchMedia(false);
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    expect(history.state).toBeNull();
    restore();
  });

  it('consumes the pushed entry via history.back() on a normal close', () => {
    const restore = stubMobileMatchMedia(true);
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    closeDropdownPanel(a);
    expect(backSpy).toHaveBeenCalledTimes(1);
    restore();
  });

  it('does not call history.back() when closing with isPopStateTriggered', () => {
    const restore = stubMobileMatchMedia(true);
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    closeDropdownPanel(a, { isPopStateTriggered: true });
    expect(backSpy).not.toHaveBeenCalled();
    restore();
  });

  it('handleDropdownPopState closes the open panel', () => {
    const restore = stubMobileMatchMedia(true);
    const a = buildDropdownFixture('a');
    openDropdownPanel(a);
    handleDropdownPopState();
    expect(a.panel.classList.contains('hidden')).toBe(true);
    restore();
  });

  it('handleDropdownPopState does nothing when no dropdown is open', () => {
    expect(() => handleDropdownPopState()).not.toThrow();
  });

  // Regression test for the race described in the PR #47 review: opening a
  // second mobile sheet while a first is already open used to run the first
  // panel's normal close path, which called the asynchronous history.back()
  // immediately followed, in the same tick, by the second panel's synchronous
  // history.pushState() — a known browser footgun that can desync
  // dismissingViaHistoryBack from the popstate it's meant to consume. The
  // auto-close branch must skip history.back() entirely (this is "one modal
  // auto-closing another", not a user dismissal) and push exactly once, for
  // the newly-opened panel.
  it('switching directly between two mobile sheets does not call history.back()', () => {
    const restore = stubMobileMatchMedia(true);
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    const a = buildDropdownFixture('a');
    const b = buildDropdownFixture('b');
    openDropdownPanel(a);
    openDropdownPanel(b);
    expect(backSpy).not.toHaveBeenCalled();
    restore();
  });

  it('switching directly between two mobile sheets pushes exactly one history entry, for the newly-opened panel', () => {
    const restore = stubMobileMatchMedia(true);
    const pushStateSpy = vi.spyOn(history, 'pushState');
    const a = buildDropdownFixture('a');
    const b = buildDropdownFixture('b');
    openDropdownPanel(a);
    pushStateSpy.mockClear();
    openDropdownPanel(b);
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
    restore();
  });
});

describe('handleDropdownTabKey (focus trap on the mobile sheet)', () => {
  function buildFixtureWithFocusableRows(prefix: string): DropdownElements {
    const elements = buildDropdownFixture(prefix);
    const first = document.createElement('input');
    first.type = 'checkbox';
    const second = document.createElement('input');
    second.type = 'checkbox';
    elements.panel.append(first, second);
    return elements;
  }

  function makeTabEvent(shiftKey: boolean): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
  }

  it('wraps Tab from the last focusable element back to the first when the mobile sheet is active', () => {
    const restore = stubMobileMatchMedia(true);
    const a = buildFixtureWithFocusableRows('a');
    openDropdownPanel(a);
    const focusableElements = a.panel.querySelectorAll('input, button');
    (focusableElements[focusableElements.length - 1] as HTMLElement).focus();
    handleDropdownTabKey(makeTabEvent(false));
    expect(document.activeElement).toBe(focusableElements[0]);
    restore();
  });

  it('wraps Shift+Tab from the first focusable element back to the last when the mobile sheet is active', () => {
    const restore = stubMobileMatchMedia(true);
    const a = buildFixtureWithFocusableRows('a');
    openDropdownPanel(a);
    const focusableElements = a.panel.querySelectorAll('input, button');
    (focusableElements[0] as HTMLElement).focus();
    handleDropdownTabKey(makeTabEvent(true));
    expect(document.activeElement).toBe(focusableElements[focusableElements.length - 1]);
    restore();
  });

  it('does not trap Tab on the desktop popover', () => {
    const restore = stubMobileMatchMedia(false);
    const a = buildFixtureWithFocusableRows('a');
    openDropdownPanel(a);
    const focusableElements = a.panel.querySelectorAll('input, button');
    const lastFocusable = focusableElements[focusableElements.length - 1] as HTMLElement;
    lastFocusable.focus();
    const event = makeTabEvent(false);
    handleDropdownTabKey(event);
    expect(document.activeElement).toBe(lastFocusable);
    expect(event.defaultPrevented).toBe(false);
    restore();
  });

  it('does nothing when no dropdown is open', () => {
    const restore = stubMobileMatchMedia(true);
    expect(() => handleDropdownTabKey(makeTabEvent(false))).not.toThrow();
    restore();
  });

  it('ignores non-Tab keys', () => {
    const restore = stubMobileMatchMedia(true);
    const a = buildFixtureWithFocusableRows('a');
    openDropdownPanel(a);
    const focusableElements = a.panel.querySelectorAll('input, button');
    const lastFocusable = focusableElements[focusableElements.length - 1] as HTMLElement;
    lastFocusable.focus();
    handleDropdownTabKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(document.activeElement).toBe(lastFocusable);
    restore();
  });

  it('skips focusable elements inside a hidden ancestor within the panel', () => {
    const restore = stubMobileMatchMedia(true);
    const a = buildFixtureWithFocusableRows('a');
    const rows = a.panel.querySelectorAll('input');
    const hiddenWrapper = document.createElement('div');
    hiddenWrapper.className = 'hidden';
    rows[1].replaceWith(hiddenWrapper);
    hiddenWrapper.appendChild(rows[1]);
    openDropdownPanel(a);
    rows[0].focus();
    handleDropdownTabKey(makeTabEvent(false));
    // The second row is hidden, so the first row is both first and last —
    // Tab forward from it wraps back to itself rather than reaching the
    // hidden row.
    expect(document.activeElement).toBe(rows[0]);
    restore();
  });
});
