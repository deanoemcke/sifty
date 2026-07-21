// ── AI filter dropdown ───────────────────────────────────────────────────────
// Mobile-only trigger/panel wiring for the AI filter row. On desktop the row
// (label + textarea + Filter button) stays inline exactly as before — this
// module only matters at the `≤640px` breakpoint, where a new icon-only
// trigger reveals the row as a full-screen sheet, reusing dropdownPanel.ts's
// open/close/dismiss mechanics (outside-click, Escape, back button, Tab
// focus-trap) so it behaves identically to the Show/Sort dropdowns and
// auto-closes/is auto-closed by them.
//
// The panel's existing `#aiFilterPanel` row must stay visible on desktop at
// all times, so it can't be toggled via the global `.hidden` class (that's
// `!important` and applies at every width). Instead it's opened/closed via a
// dedicated `ai-filter-panel-collapsed` class whose `display: none` rule is
// scoped inside the `≤640px` media query in styles.css — harmless (a no-op)
// above that width.

import { getElement } from './domUtils';
import {
  buildDropdownTriggerHtml,
  closeDropdownPanel,
  type DropdownElementIds,
  type DropdownElements,
  getDropdownElements,
  toggleDropdownPanel,
} from './dropdownPanel';
import { FILTER_ICON } from './icons';

const AI_FILTER_PANEL_COLLAPSED_CLASS = 'ai-filter-panel-collapsed';

const AI_FILTER_DROPDOWN_IDS: DropdownElementIds = {
  root: 'aiFilterDropdown',
  trigger: 'aiFilterDropdownBtn',
  panel: 'aiFilterPanel',
  footer: 'aiFilterBtn',
  closedClass: AI_FILTER_PANEL_COLLAPSED_CLASS,
};

function getAiFilterDropdownElements(): DropdownElements {
  return getDropdownElements(AI_FILTER_DROPDOWN_IDS);
}

// One-time init: builds the trigger button into its mount point and starts
// the panel collapsed, mirroring buildDropdownShell's panel starting with
// `hidden` already present.
export function populateAiFilterDropdown(): void {
  getElement(AI_FILTER_DROPDOWN_IDS.root).innerHTML = buildDropdownTriggerHtml(
    { trigger: AI_FILTER_DROPDOWN_IDS.trigger, panel: AI_FILTER_DROPDOWN_IDS.panel },
    'AI filter',
    FILTER_ICON
  );
  getElement(AI_FILTER_DROPDOWN_IDS.panel).classList.add(AI_FILTER_PANEL_COLLAPSED_CLASS);
}

export function toggleAiFilterDropdownPanel(): void {
  toggleDropdownPanel(getAiFilterDropdownElements());
}

export function closeAiFilterDropdownPanel(): void {
  closeDropdownPanel(getAiFilterDropdownElements());
}
