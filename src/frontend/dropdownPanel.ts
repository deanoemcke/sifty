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

// Applied to <body> while the mobile full-screen sheet is open, so the page
// behind the (visually opaque, position: fixed) sheet can't be scrolled.
const SCROLL_LOCK_CLASS = 'scroll-locked';

let openDropdown: DropdownElements | null = null;

export function openDropdownPanel(elements: DropdownElements): void {
  if (openDropdown && openDropdown.panel !== elements.panel) closeDropdownPanel(openDropdown);
  elements.panel.classList.remove('hidden');
  elements.trigger.setAttribute('aria-expanded', 'true');
  if (isMobileSheetActive()) document.body.classList.add(SCROLL_LOCK_CLASS);
  openDropdown = elements;
}

export function closeDropdownPanel(elements: DropdownElements): void {
  // Hiding the panel while it contains focus would silently drop focus to
  // <body>; return it to the trigger instead. The guard means mouse
  // dismissals (which have already moved focus elsewhere) are left alone.
  const isFocusInsidePanel = elements.panel.contains(document.activeElement);
  elements.panel.classList.add('hidden');
  elements.trigger.setAttribute('aria-expanded', 'false');
  document.body.classList.remove(SCROLL_LOCK_CLASS);
  if (isFocusInsidePanel) elements.trigger.focus();
  if (openDropdown?.panel === elements.panel) openDropdown = null;
}

export function toggleDropdownPanel(elements: DropdownElements): void {
  if (elements.panel.classList.contains('hidden')) openDropdownPanel(elements);
  else closeDropdownPanel(elements);
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
  if (!openDropdown) return;
  if (openDropdown.root.contains(target)) return;
  if (isLabelForOpenTrigger(target, openDropdown.trigger)) return;
  closeDropdownPanel(openDropdown);
}

export function handleEscapeKey(key: string): void {
  if (key === 'Escape' && openDropdown) closeDropdownPanel(openDropdown);
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
  if (event.key !== 'Tab' || !openDropdown || !isMobileSheetActive()) return;
  const focusableElements = getFocusableElements(openDropdown.panel);
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

// Sole writer of the trigger/footer text. Writes into the trigger's label
// span rather than the button's own textContent, since the button also holds
// a caret icon that textContent would wipe out.
export function setDropdownLabel(elements: DropdownElements, text: string): void {
  requireChild<HTMLElement>(elements.trigger, '.dropdown-trigger-label').textContent = text;
  elements.footer.textContent = text;
}

export function resetOpenDropdown(): void {
  openDropdown = null;
}
