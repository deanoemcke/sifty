// Expand/collapse behaviour for the deep-search extras inside a listing card.
// Expanding also marks the enclosing .listing-card so CSS can span it across
// the full grid row; collapsing returns it to its grid cell.

export function expandExtras(extrasBody: HTMLElement): void {
  extrasBody.classList.remove("collapsed");
  const toggleBtn = extrasBody.nextElementSibling as HTMLElement | null;
  if (toggleBtn) toggleBtn.style.display = "";
  extrasBody.closest(".listing-card")?.classList.add("expanded");
}

export function collapseExtras(toggleBtn: HTMLButtonElement): void {
  const extrasBody = toggleBtn.previousElementSibling as HTMLElement | null;
  if (!extrasBody) throw new Error("collapseExtras: missing .extras-body sibling");
  extrasBody.classList.add("collapsed");
  toggleBtn.style.display = "none";
  toggleBtn.closest(".listing-card")?.classList.remove("expanded");
}
