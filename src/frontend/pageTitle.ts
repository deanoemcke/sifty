import { getElement } from "./domUtils";

export function computeBrandTitle(worktreeLabel: string | null): string {
  return worktreeLabel ? `Sifty (${worktreeLabel})` : "Sifty";
}

export function applyBrandTitle(worktreeLabel: string | null): void {
  const title = computeBrandTitle(worktreeLabel);
  document.title = title;
  getElement("brandHeading").textContent = title;
}
