// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { activateSidebarTab } from "./sidebarTabs";

function buildSidebar(): {
  sidebar: HTMLElement;
  searchTabBtn: HTMLButtonElement;
  favouritesTabBtn: HTMLButtonElement;
  searchTabPanel: HTMLElement;
  favouritesPanel: HTMLElement;
} {
  const sidebar = document.createElement("aside");
  sidebar.innerHTML = `
    <nav class="sidebar-tabs">
      <button id="searchTabBtn" class="sidebar-tab active" aria-selected="true">Search</button>
      <button id="favouritesTabBtn" class="sidebar-tab" aria-selected="false">Favourites</button>
    </nav>
    <div id="searchTabPanel"></div>
    <div id="savedSearchesPanel" class="hidden"></div>
  `;
  const searchTabBtn = sidebar.querySelector<HTMLButtonElement>("#searchTabBtn");
  const favouritesTabBtn = sidebar.querySelector<HTMLButtonElement>("#favouritesTabBtn");
  const searchTabPanel = sidebar.querySelector<HTMLElement>("#searchTabPanel");
  const favouritesPanel = sidebar.querySelector<HTMLElement>("#savedSearchesPanel");
  if (!searchTabBtn || !favouritesTabBtn || !searchTabPanel || !favouritesPanel)
    throw new Error("test fixture is malformed");
  return { sidebar, searchTabBtn, favouritesTabBtn, searchTabPanel, favouritesPanel };
}

describe("activateSidebarTab", () => {
  let sidebar: HTMLElement;
  let searchTabBtn: HTMLButtonElement;
  let favouritesTabBtn: HTMLButtonElement;
  let searchTabPanel: HTMLElement;
  let favouritesPanel: HTMLElement;

  beforeEach(() => {
    ({ sidebar, searchTabBtn, favouritesTabBtn, searchTabPanel, favouritesPanel } = buildSidebar());
  });

  it("shows the favourites panel and hides the search panel", () => {
    activateSidebarTab(sidebar, "favourites");
    expect(favouritesPanel.classList.contains("hidden")).toBe(false);
    expect(searchTabPanel.classList.contains("hidden")).toBe(true);
  });

  it("marks the favourites tab button active and the search tab button inactive", () => {
    activateSidebarTab(sidebar, "favourites");
    expect(favouritesTabBtn.classList.contains("active")).toBe(true);
    expect(favouritesTabBtn.getAttribute("aria-selected")).toBe("true");
    expect(searchTabBtn.classList.contains("active")).toBe(false);
    expect(searchTabBtn.getAttribute("aria-selected")).toBe("false");
  });

  it("switches back to the search tab", () => {
    activateSidebarTab(sidebar, "favourites");
    activateSidebarTab(sidebar, "search");
    expect(searchTabPanel.classList.contains("hidden")).toBe(false);
    expect(favouritesPanel.classList.contains("hidden")).toBe(true);
    expect(searchTabBtn.classList.contains("active")).toBe(true);
    expect(searchTabBtn.getAttribute("aria-selected")).toBe("true");
    expect(favouritesTabBtn.classList.contains("active")).toBe(false);
    expect(favouritesTabBtn.getAttribute("aria-selected")).toBe("false");
  });

  it("is idempotent when activating the already-active tab", () => {
    activateSidebarTab(sidebar, "search");
    activateSidebarTab(sidebar, "search");
    expect(searchTabPanel.classList.contains("hidden")).toBe(false);
    expect(favouritesPanel.classList.contains("hidden")).toBe(true);
  });

  it("throws when a required element is missing", () => {
    favouritesPanel.remove();
    expect(() => activateSidebarTab(sidebar, "favourites")).toThrowError(/savedSearchesPanel/);
  });
});
