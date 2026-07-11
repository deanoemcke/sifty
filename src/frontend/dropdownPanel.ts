// ── Dropdown panel ────────────────────────────────────────────────────────────
// Shared open/close/dismiss mechanics used identically by the results header's
// Show and Sort dropdowns, so both behave exactly the same way: a desktop
// anchored panel dismissed by outside-click/Escape, or (via CSS breakpoint
// only, no JS device detection) a mobile full-screen sheet dismissed by its
// sticky footer button. Tracking which dropdown is open here is what lets one
// shared outside-click/Escape listener serve both controls, and lets opening
// one close the other.

import { getElement, requireChild } from './domUtils';

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

export function getDropdownElements(ids: DropdownElementIds): DropdownElements {
  return {
    root: getElement(ids.root),
    trigger: getElement<HTMLButtonElement>(ids.trigger),
    panel: getElement(ids.panel),
    footer: getElement<HTMLButtonElement>(ids.footer),
  };
}

let openDropdown: DropdownElements | null = null;

export function openDropdownPanel(elements: DropdownElements): void {
  if (openDropdown && openDropdown.panel !== elements.panel) closeDropdownPanel(openDropdown);
  elements.panel.classList.remove('hidden');
  elements.trigger.setAttribute('aria-expanded', 'true');
  openDropdown = elements;
}

export function closeDropdownPanel(elements: DropdownElements): void {
  elements.panel.classList.add('hidden');
  elements.trigger.setAttribute('aria-expanded', 'false');
  if (openDropdown?.panel === elements.panel) openDropdown = null;
}

export function toggleDropdownPanel(elements: DropdownElements): void {
  if (elements.panel.classList.contains('hidden')) openDropdownPanel(elements);
  else closeDropdownPanel(elements);
}

export function handleOutsideClick(target: Node): void {
  if (openDropdown && !openDropdown.root.contains(target)) closeDropdownPanel(openDropdown);
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
