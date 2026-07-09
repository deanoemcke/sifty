// Sidebar tab controller — pure DOM helpers, no side effects at module scope.
// The favourites panel keeps its legacy #savedSearchesPanel id until the full
// saved-searches → favourites internal rename (tracked as deferred work).

import { animateHeightTransition } from './heightAnimation';

export type SidebarTabName = 'search' | 'favourites';

const TAB_BUTTON_IDS_BY_TAB_NAME: Record<SidebarTabName, string> = {
  search: 'searchTabBtn',
  favourites: 'favouritesTabBtn',
};

const TAB_PANEL_IDS_BY_TAB_NAME: Record<SidebarTabName, string> = {
  search: 'searchTabPanel',
  favourites: 'savedSearchesPanel',
};

const SIDEBAR_TAB_NAMES: SidebarTabName[] = ['search', 'favourites'];

function requireElement(root: ParentNode, id: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`#${id}`);
  if (!element) throw new Error(`Element #${id} not found`);
  return element;
}

export function activateSidebarTab(root: ParentNode, tabName: SidebarTabName): void {
  const targetPanel = requireElement(root, TAB_PANEL_IDS_BY_TAB_NAME[tabName]);
  const outgoingPanel = SIDEBAR_TAB_NAMES.map((name) =>
    requireElement(root, TAB_PANEL_IDS_BY_TAB_NAME[name])
  ).find((panel) => panel !== targetPanel && !panel.classList.contains('hidden'));
  // Measure before the toggle below collapses the outgoing panel to display:none.
  const outgoingHeight = outgoingPanel?.offsetHeight;

  for (const candidateTabName of SIDEBAR_TAB_NAMES) {
    const isActive = candidateTabName === tabName;
    const button = requireElement(root, TAB_BUTTON_IDS_BY_TAB_NAME[candidateTabName]);
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
    requireElement(root, TAB_PANEL_IDS_BY_TAB_NAME[candidateTabName]).classList.toggle(
      'hidden',
      !isActive
    );
  }

  // Slide the freshly shown panel from the previous panel's height to its own.
  if (outgoingHeight !== undefined) animateHeightTransition(targetPanel, outgoingHeight);
}
