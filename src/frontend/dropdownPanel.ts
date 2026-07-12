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
    <button id="${ids.trigger}" class="dropdown-trigger-btn" type="button" aria-haspopup="true" aria-expanded="false">
      <span class="dropdown-trigger-label">${title}</span>${DROPDOWN_CARET_ICON}
    </button>
    <div id="${ids.panel}" class="dropdown-panel hidden">
      <div class="dropdown-panel-header">${title}</div>
      <div class="dropdown-panel-options" id="${ids.options}"></div>
      <div class="dropdown-panel-footer">
        <button id="${ids.footer}" class="dropdown-footer-btn" type="button">${title}</button>
      </div>
    </div>`;
}

let openDropdown: DropdownElements | null = null;

export function openDropdownPanel(elements: DropdownElements): void {
  if (openDropdown && openDropdown.panel !== elements.panel) closeDropdownPanel(openDropdown);
  elements.panel.classList.remove('hidden');
  elements.trigger.setAttribute('aria-expanded', 'true');
  openDropdown = elements;
}

export function closeDropdownPanel(elements: DropdownElements): void {
  // Hiding the panel while it contains focus would silently drop focus to
  // <body>; return it to the trigger instead. The guard means mouse
  // dismissals (which have already moved focus elsewhere) are left alone.
  const isFocusInsidePanel = elements.panel.contains(document.activeElement);
  elements.panel.classList.add('hidden');
  elements.trigger.setAttribute('aria-expanded', 'false');
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
