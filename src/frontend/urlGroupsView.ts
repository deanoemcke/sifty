// ── URL recipe groups (DOM view) ──────────────────────────────────────────────
// Renders and reconciles the per-recipe group containers around URL card rows.
// Grouping logic (which cards form a group, header wording) lives in
// urlGroups.ts; this module owns only the DOM and the expansion state.

import { recipeIdForUrl } from "../lib/recipes/matcher";
import type { RecipeId } from "../lib/recipes/metadata";
import { getElement, requireChild } from "./domUtils";
import { collapseElementAsync, expandElement } from "./heightAnimation";
import { esc } from "./html";
import { recipeFaviconHtml } from "./recipeDisplay";
import { type UrlCard, urlCardData, urlCards } from "./urlCardStore";
import { computeUrlGroups, groupHeaderView, type UrlGroupMemberSnapshot } from "./urlGroups";

const CHEVRON_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

const urlGroupExpandedByRecipeId = new Map<RecipeId, boolean>();

export function urlGroupMemberSnapshot(card: UrlCard): UrlGroupMemberSnapshot {
  const data = urlCardData(card);
  return {
    url: card.dom.input.value.trim(),
    searchStatus: data.searchStatus,
    listingUrls: data.listingUrls,
  };
}

export function findUrlGroupElement(recipeId: RecipeId): HTMLElement | null {
  return getElement("urlCardsContainer").querySelector<HTMLElement>(
    `.url-group[data-recipe-id="${recipeId}"]`,
  );
}

export function buildUrlGroupElement(recipeId: RecipeId): HTMLElement {
  const groupEl = document.createElement("div");
  groupEl.className = "url-group";
  groupEl.dataset.recipeId = String(recipeId);
  groupEl.innerHTML = `
    <div class="url-group-header">
      ${recipeFaviconHtml(recipeId)}
      <span class="url-group-status"></span>
      <button class="cache-clear-btn url-group-cancel hidden" type="button">cancel</button>
      <button class="btn icon-btn url-group-toggle" type="button" title="Show URLs">${CHEVRON_ICON}</button>
    </div>
    <div class="url-group-rows hidden"></div>
  `;
  return groupEl;
}

// Reconciles the group containers with the cards' current recipes: groups are
// kept in recipe-id order at the top, unmatched rows stay loose below them.
export function syncUrlGroups(): void {
  const container = getElement("urlCardsContainer");
  const summaries = computeUrlGroups(urlCards.map(urlGroupMemberSnapshot));
  for (const summary of summaries) {
    const groupEl = findUrlGroupElement(summary.recipeId) ?? buildUrlGroupElement(summary.recipeId);
    container.appendChild(groupEl);
    const rowsEl = requireChild<HTMLElement>(groupEl, ".url-group-rows");
    if (urlGroupExpandedByRecipeId.get(summary.recipeId)) rowsEl.classList.remove("hidden");
    groupEl.classList.toggle("expanded", urlGroupExpandedByRecipeId.get(summary.recipeId) ?? false);
  }
  for (const card of urlCards) {
    const recipeId = recipeIdForUrl(card.dom.input.value.trim());
    const rowEl = card.dom.containerElement;
    const targetParent =
      recipeId === null
        ? container
        : (findUrlGroupElement(recipeId)?.querySelector<HTMLElement>(".url-group-rows") ??
          container);
    if (rowEl.parentElement !== targetParent) targetParent.appendChild(rowEl);
  }
  for (const groupEl of [...container.querySelectorAll<HTMLElement>(".url-group")]) {
    if (requireChild<HTMLElement>(groupEl, ".url-group-rows").children.length === 0)
      groupEl.remove();
  }
  updateUrlGroupHeaders();
}

export function updateUrlGroupHeaders(): void {
  for (const summary of computeUrlGroups(urlCards.map(urlGroupMemberSnapshot))) {
    const groupEl = findUrlGroupElement(summary.recipeId);
    if (!groupEl) continue;
    const view = groupHeaderView(summary);
    const statusEl = requireChild<HTMLElement>(groupEl, ".url-group-status");
    statusEl.innerHTML =
      (view.showSpinner ? '<span class="spinner"></span>' : "") +
      `<span>${esc(view.primaryText)}</span>`;
    requireChild<HTMLElement>(groupEl, ".url-group-cancel").classList.toggle(
      "hidden",
      !view.showCancel,
    );
  }
}

export function expandUrlGroup(recipeId: RecipeId): void {
  if (urlGroupExpandedByRecipeId.get(recipeId)) return;
  urlGroupExpandedByRecipeId.set(recipeId, true);
  const groupEl = findUrlGroupElement(recipeId);
  if (!groupEl) return;
  groupEl.classList.add("expanded");
  expandElement(requireChild<HTMLElement>(groupEl, ".url-group-rows"));
}

export function toggleUrlGroup(recipeId: RecipeId): void {
  const groupEl = findUrlGroupElement(recipeId);
  if (!groupEl) return;
  const rowsEl = requireChild<HTMLElement>(groupEl, ".url-group-rows");
  const isExpanded = urlGroupExpandedByRecipeId.get(recipeId) ?? false;
  urlGroupExpandedByRecipeId.set(recipeId, !isExpanded);
  groupEl.classList.toggle("expanded", !isExpanded);
  if (isExpanded) collapseElementAsync(rowsEl);
  else expandElement(rowsEl);
}
