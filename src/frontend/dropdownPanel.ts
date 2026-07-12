// ── Dropdown panel ────────────────────────────────────────────────────────────
// Shared open/close/dismiss mechanics used identically by the results header's
// Show and Sort dropdowns, so both behave exactly the same way: a desktop
// anchored panel dismissed by outside-click/Escape, or (via CSS breakpoint
// only, no JS device detection) a mobile full-screen sheet dismissed by its
// sticky footer button. Tracking which dropdown is open here is what lets one
// shared outside-click/Escape listener serve both controls, and lets opening
// one close the other.

import { getElement, requireChild } from './domUtils';
import { CHEVRON_ICON } from './icons';
import {
  lockBodyScroll,
  popModalHistoryEntryIfPresent,
  pushModalHistoryEntry,
  unlockBodyScroll,
} from './modalOverlay';

export interface DropdownElements {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  panel: HTMLElement;
  footer: HTMLButtonElement;
}

export interface DropdownElementIds {
  root: string;
  trigger: string;
  panel: string;
  footer: string;
}

// Superset of DropdownElementIds used only by buildDropdownShell, since the
// options container has no runtime element (open/close/focus mechanics never
// touch it) and so has no place on DropdownElements/getDropdownElements.
export interface DropdownShellIds extends DropdownElementIds {
  options: string;
}

export function getDropdownElements(ids: DropdownElementIds): DropdownElements {
  return {
    root: getElement(ids.root),
    trigger: getElement<HTMLButtonElement>(ids.trigger),
    panel: getElement(ids.panel),
    footer: getElement<HTMLButtonElement>(ids.footer),
  };
}

// The dropdown caret is CHEVRON_ICON (icons.ts) plus the dropdown-specific
// class that drives its muted colour and open/close rotation — derived once
// here rather than hand-copied, so the SVG markup itself has one source.
const DROPDOWN_CARET_ICON = CHEVRON_ICON.replace('<svg ', '<svg class="dropdown-caret" ');

// Builds the full trigger-button + panel DOM for one dropdown into its mount
// point (a bare `<div id="...">` in index.html), so the shell markup has a
// single source instead of being hand-mirrored across index.html and test
// fixtures. `title` seeds the trigger/footer text and the (mobile-only,
// always-visible) panel header; populate*Controls() callers overwrite the
// trigger/footer text via setDropdownLabel immediately after, so in practice
// `title` only persists in the panel header.
export function buildDropdownShell(ids: DropdownShellIds, title: string): void {
  getElement(ids.root).innerHTML = `
    <button id="${ids.trigger}" class="dropdown-trigger-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="${ids.panel}">
      <span class="dropdown-trigger-label">${title}</span>${DROPDOWN_CARET_ICON}
    </button>
    <div id="${ids.panel}" class="dropdown-panel hidden" role="group" aria-label="${title}">
      <div class="dropdown-panel-header">${title}</div>
      <div class="dropdown-panel-options" id="${ids.options}"></div>
      <div class="dropdown-panel-footer">
        <button id="${ids.footer}" class="dropdown-footer-btn" type="button">${title}</button>
      </div>
    </div>`;
}

// Mirrors the `@media (max-width: 640px)` breakpoint in styles.css that turns
// the panel into a full-screen sheet (see the comment above that rule). CSS
// remains the single source of truth for the breakpoint value itself; this is
// the one place JS needs to know the layout has switched, to decide whether
// the sheet should behave like a modal (focus-trapped, scroll-locked) or stay
// a non-modal anchored popover. `window.matchMedia` isn't implemented by
// jsdom, so this degrades to "not mobile" outside a real browser — tests
// stub `window.matchMedia` to exercise the mobile branch.
const MOBILE_SHEET_MEDIA_QUERY = '(max-width: 640px)';

function isMobileSheetActive(): boolean {
  return (
    typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_SHEET_MEDIA_QUERY).matches
  );
}

// Tracks which dropdown is open as plain, serializable ids rather than the
// live DropdownElements themselves — see CLAUDE.md's "State is data, not
// DOM" principle. Elements are re-resolved via getDropdownElements() on
// demand, so this can never hold a stale reference to a detached node (e.g.
// if a future call site rebuilt the shell via buildDropdownShell while a
// panel was open).
function toDropdownElementIds(elements: DropdownElements): DropdownElementIds {
  return {
    root: elements.root.id,
    trigger: elements.trigger.id,
    panel: elements.panel.id,
    footer: elements.footer.id,
  };
}

let openDropdownIds: DropdownElementIds | null = null;

export function openDropdownPanel(elements: DropdownElements): void {
  if (openDropdownIds && openDropdownIds.panel !== elements.panel.id) {
    closeDropdownPanel(getDropdownElements(openDropdownIds));
  }
  elements.panel.classList.remove('hidden');
  elements.trigger.setAttribute('aria-expanded', 'true');
  if (isMobileSheetActive()) {
    lockBodyScroll();
    pushModalHistoryEntry();
  }
  openDropdownIds = toDropdownElementIds(elements);
}

export interface CloseDropdownPanelOptions {
  // Set when this close is a reaction to a popstate event (the user pressed
  // the browser back button), so we don't call history.back() again for an
  // entry the back button has already consumed.
  isPopStateTriggered?: boolean;
}

export function closeDropdownPanel(
  elements: DropdownElements,
  options: CloseDropdownPanelOptions = {}
): void {
  // Hiding the panel while it contains focus would silently drop focus to
  // <body>; return it to the trigger instead. The guard means mouse
  // dismissals (which have already moved focus elsewhere) are left alone.
  const isFocusInsidePanel = elements.panel.contains(document.activeElement);
  elements.panel.classList.add('hidden');
  elements.trigger.setAttribute('aria-expanded', 'false');
  unlockBodyScroll();
  if (!options.isPopStateTriggered) popModalHistoryEntryIfPresent();
  if (isFocusInsidePanel) elements.trigger.focus();
  if (openDropdownIds?.panel === elements.panel.id) openDropdownIds = null;
}

export function toggleDropdownPanel(elements: DropdownElements): void {
  if (elements.panel.classList.contains('hidden')) openDropdownPanel(elements);
  else closeDropdownPanel(elements);
}

// Wired to the window's popstate event in app.ts, so pressing the browser
// back button closes whichever dropdown sheet is open instead of navigating
// away from the page.
export function handleDropdownPopState(): void {
  if (openDropdownIds) {
    closeDropdownPanel(getDropdownElements(openDropdownIds), { isPopStateTriggered: true });
  }
}

// The external <label for="…"> is part of the dropdown's operating surface
// even though it sits outside the root: the browser forwards its click to the
// trigger button. Treating it as an outside click would close the panel a
// beat before that forwarded click toggles it straight back open, so the
// label could open the panel but never close it.
function isLabelForOpenTrigger(target: Node, trigger: HTMLButtonElement): boolean {
  const targetElement = target instanceof Element ? target : target.parentElement;
  return targetElement?.closest('label')?.htmlFor === trigger.id;
}

export function handleOutsideClick(target: Node): void {
  if (!openDropdownIds) return;
  const elements = getDropdownElements(openDropdownIds);
  if (elements.root.contains(target)) return;
  if (isLabelForOpenTrigger(target, elements.trigger)) return;
  closeDropdownPanel(elements);
}

export function handleEscapeKey(key: string): void {
  if (key === 'Escape' && openDropdownIds) closeDropdownPanel(getDropdownElements(openDropdownIds));
}

// An ancestor (up to, but not including, `container`) carrying the `.hidden`
// class means `element` isn't reachable — e.g. the Show panel's "Sold" row
// when the current results contain no sold listings (renderShowOptions in
// showDropdown.ts hides the row itself, not its checkbox). Walking classList
// rather than checking layout (`offsetParent`/`checkVisibility`) keeps this
// correct under jsdom, which never computes layout.
function isElementHiddenWithinContainer(element: HTMLElement, container: HTMLElement): boolean {
  for (
    let node: HTMLElement | null = element;
    node && node !== container;
    node = node.parentElement
  ) {
    if (node.classList.contains('hidden')) return true;
  }
  return false;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = container.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  return Array.from(candidates).filter(
    (element) =>
      !element.hasAttribute('disabled') && !isElementHiddenWithinContainer(element, container)
  );
}

// Modal-style focus trap: on the mobile full-screen sheet the page behind the
// panel is invisible and scroll-locked, so Tab must not be allowed to escape
// into it — Tab/Shift+Tab instead cycle within the panel's own focusable
// elements. The desktop anchored popover is non-modal (the rest of the page
// stays visible and reachable), so it deliberately keeps native Tab-out
// behaviour and this is a no-op there.
export function handleDropdownTabKey(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !openDropdownIds || !isMobileSheetActive()) return;
  const focusableElements = getFocusableElements(getDropdownElements(openDropdownIds).panel);
  if (focusableElements.length === 0) return;
  const first = focusableElements[0];
  const last = focusableElements[focusableElements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// Sole writer of the trigger/footer text. Takes the two texts separately —
// the footer button (the mobile sheet's sticky "done" button) reads as a
// call-to-action ("Show 2 of 3 results") while the trigger stays a bare
// summary ("2 of 3 results") — rather than forcing callers to derive one
// from the other. Writes into the trigger's label span rather than the
// button's own textContent, since the button also holds a caret icon that
// textContent would wipe out.
export function setDropdownLabel(
  elements: DropdownElements,
  triggerText: string,
  footerText: string
): void {
  requireChild<HTMLElement>(elements.trigger, '.dropdown-trigger-label').textContent = triggerText;
  elements.footer.textContent = footerText;
}

export function resetOpenDropdown(): void {
  openDropdownIds = null;
}
