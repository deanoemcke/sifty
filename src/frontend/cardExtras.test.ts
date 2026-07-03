// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { collapseExtras, expandExtras } from "./cardExtras";

function buildCard(): { card: HTMLElement; body: HTMLElement; toggleBtn: HTMLButtonElement } {
  const card = document.createElement("div");
  card.className = "listing-card";
  card.innerHTML = `
    <div class="listing-card-content">
      <div class="listing-body">
        <div class="listing-extras">
          <div class="extras-body collapsed"><div class="extras-fade"></div></div>
          <button class="extras-toggle" style="display:none">Show less</button>
        </div>
      </div>
    </div>
  `;
  const body = card.querySelector<HTMLElement>(".extras-body");
  const toggleBtn = card.querySelector<HTMLButtonElement>(".extras-toggle");
  if (!body || !toggleBtn) throw new Error("test fixture is malformed");
  return { card, body, toggleBtn };
}

describe("expandExtras", () => {
  let card: HTMLElement;
  let body: HTMLElement;
  let toggleBtn: HTMLButtonElement;

  beforeEach(() => {
    ({ card, body, toggleBtn } = buildCard());
  });

  it("removes the collapsed state from the extras body", () => {
    expandExtras(body);
    expect(body.classList.contains("collapsed")).toBe(false);
  });

  it("shows the sibling toggle button", () => {
    expandExtras(body);
    expect(toggleBtn.style.display).toBe("");
  });

  it("marks the enclosing listing card as expanded so it spans the grid row", () => {
    expandExtras(body);
    expect(card.classList.contains("expanded")).toBe(true);
  });
});

describe("collapseExtras", () => {
  let card: HTMLElement;
  let body: HTMLElement;
  let toggleBtn: HTMLButtonElement;

  beforeEach(() => {
    ({ card, body, toggleBtn } = buildCard());
    expandExtras(body);
  });

  it("restores the collapsed state on the extras body", () => {
    collapseExtras(toggleBtn);
    expect(body.classList.contains("collapsed")).toBe(true);
  });

  it("hides the toggle button", () => {
    collapseExtras(toggleBtn);
    expect(toggleBtn.style.display).toBe("none");
  });

  it("removes the expanded mark from the enclosing listing card", () => {
    collapseExtras(toggleBtn);
    expect(card.classList.contains("expanded")).toBe(false);
  });
});
