// ── URL recipe groups (DOM view) ──────────────────────────────────────────────
// Renders and reconciles the per-recipe group containers around URL card rows.
// Grouping logic (which cards form a group, header wording) lives in
// urlGroups.ts; this module owns only the DOM and the expansion state.

import { recipeGroupIdForUrl } from '../lib/recipes/matcher';
import type { RecipeId } from '../lib/recipes/metadata';
import { getElement, requireChild } from './domUtils';
import { collapseElementAsync, expandElement } from './heightAnimation';
import { esc } from './html';
import { CHEVRON_ICON } from './icons';
import { recipeFaviconHtml } from './recipeDisplay';
import { readCardUrl, type UrlCard, urlCardData, urlCards } from './urlCardStore';
import { computeUrlGroups, groupHeaderView, type UrlGroupMemberSnapshot } from './urlGroups';

const urlGroupExpandedByGroupId = new Map<RecipeId, boolean>();

export function urlGroupMemberSnapshot(card: UrlCard): UrlGroupMemberSnapshot {
  const data = urlCardData(card);
  return {
    url: readCardUrl(card),
    searchStatus: data.searchStatus,
    listingUrls: data.listingUrls,
  };
}

export function findUrlGroupElement(groupId: RecipeId): HTMLElement | null {
  return getElement('urlCardsContainer').querySelector<HTMLElement>(
    `.url-group[data-recipe-id="${groupId}"]`
  );
}

export function buildUrlGroupElement(groupId: RecipeId): HTMLElement {
  const groupEl = document.createElement('div');
  groupEl.className = 'url-group';
  groupEl.dataset.recipeId = String(groupId);
  groupEl.innerHTML = `
    <div class="url-group-header">
      ${recipeFaviconHtml(groupId)}
      <span class="url-group-status"></span>
      <button class="cache-clear-btn url-group-cancel hidden" type="button">cancel</button>
      <button class="btn icon-btn url-group-toggle" type="button" title="Show URLs">${CHEVRON_ICON}</button>
    </div>
    <div class="url-group-rows hidden"></div>
  `;
  return groupEl;
}

// Reconciles the group containers with the cards' current recipes: groups are
// kept in group-id order at the top, unmatched rows stay loose below them.
export function syncUrlGroups(): void {
  const container = getElement('urlCardsContainer');
  const summaries = computeUrlGroups(urlCards.map(urlGroupMemberSnapshot));
  summaries.forEach((summary, index) => {
    const groupEl = findUrlGroupElement(summary.groupId) ?? buildUrlGroupElement(summary.groupId);
    // appendChild always removes-then-reinserts, even when the node is
    // already in the right place — which blurs a focused descendant (e.g. a
    // card input mid-edit). Only move it when its position is actually wrong.
    if (container.children[index] !== groupEl)
      container.insertBefore(groupEl, container.children[index] ?? null);
    const rowsEl = requireChild<HTMLElement>(groupEl, '.url-group-rows');
    if (urlGroupExpandedByGroupId.get(summary.groupId)) rowsEl.classList.remove('hidden');
    groupEl.classList.toggle('expanded', urlGroupExpandedByGroupId.get(summary.groupId) ?? false);
  });
  for (const card of urlCards) {
    const groupId = recipeGroupIdForUrl(readCardUrl(card));
    const rowEl = card.dom.containerElement;
    const targetParent =
      groupId === null
        ? container
        : (findUrlGroupElement(groupId)?.querySelector<HTMLElement>('.url-group-rows') ??
          container);
    if (rowEl.parentElement !== targetParent) targetParent.appendChild(rowEl);
  }
  for (const groupEl of [...container.querySelectorAll<HTMLElement>('.url-group')]) {
    if (requireChild<HTMLElement>(groupEl, '.url-group-rows').children.length === 0)
      groupEl.remove();
  }
  updateUrlGroupHeaders();
}

export function updateUrlGroupHeaders(): void {
  for (const summary of computeUrlGroups(urlCards.map(urlGroupMemberSnapshot))) {
    const groupEl = findUrlGroupElement(summary.groupId);
    if (!groupEl) continue;
    const view = groupHeaderView(summary);
    const statusEl = requireChild<HTMLElement>(groupEl, '.url-group-status');
    statusEl.innerHTML =
      (view.showSpinner ? '<span class="spinner"></span>' : '') +
      `<span>${esc(view.primaryText)}</span>`;
    requireChild<HTMLElement>(groupEl, '.url-group-cancel').classList.toggle(
      'hidden',
      !view.showCancel
    );
  }
}

export function expandUrlGroup(groupId: RecipeId): void {
  if (urlGroupExpandedByGroupId.get(groupId)) return;
  urlGroupExpandedByGroupId.set(groupId, true);
  const groupEl = findUrlGroupElement(groupId);
  if (!groupEl) return;
  groupEl.classList.add('expanded');
  expandElement(requireChild<HTMLElement>(groupEl, '.url-group-rows'));
}

export function toggleUrlGroup(groupId: RecipeId): void {
  const groupEl = findUrlGroupElement(groupId);
  if (!groupEl) return;
  const rowsEl = requireChild<HTMLElement>(groupEl, '.url-group-rows');
  const isExpanded = urlGroupExpandedByGroupId.get(groupId) ?? false;
  urlGroupExpandedByGroupId.set(groupId, !isExpanded);
  groupEl.classList.toggle('expanded', !isExpanded);
  if (isExpanded) collapseElementAsync(rowsEl);
  else expandElement(rowsEl);
}
