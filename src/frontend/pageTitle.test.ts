// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyBrandTitle, computeBrandTitle } from "./pageTitle";

describe("computeBrandTitle", () => {
  it("returns plain 'Sifty' for the base worktree (no label)", () => {
    expect(computeBrandTitle(null)).toBe("Sifty");
  });

  it("appends the worktree label in parentheses", () => {
    expect(computeBrandTitle("sifty-webapp3")).toBe("Sifty (sifty-webapp3)");
  });
});

describe("applyBrandTitle", () => {
  beforeEach(() => {
    document.body.innerHTML = `<h1 id="brandHeading">Sifty</h1>`;
    document.title = "Sifty";
  });

  it("sets document.title and the brand heading for the base worktree", () => {
    applyBrandTitle(null);
    expect(document.title).toBe("Sifty");
    expect(document.getElementById("brandHeading")?.textContent).toBe("Sifty");
  });

  it("sets document.title and the brand heading for a numbered worktree", () => {
    applyBrandTitle("sifty-webapp3");
    expect(document.title).toBe("Sifty (sifty-webapp3)");
    expect(document.getElementById("brandHeading")?.textContent).toBe("Sifty (sifty-webapp3)");
  });
});
