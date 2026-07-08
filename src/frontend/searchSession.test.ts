// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDiscoverySubmitAsync, loadSavedSearchAsync } from "./searchSession";
import { resetState } from "./state";
import { createUrlCard } from "./urlCardRow";
import { resetUrlCardStore, urlCards } from "./urlCardStore";

beforeEach(() => {
  resetState();
  resetUrlCardStore();
  document.body.innerHTML = `
    <textarea id="discoveryPrompt">lamp</textarea>
    <input id="discoveryMaxPrice" />
    <input id="discoveryAllowShipping" type="checkbox" />
    <select id="discoveryRegion"><option value="">Any</option></select>
    <button id="discoveryBtn"></button>

    <div id="urlsSection" class="hidden">
      <div id="urlsCard" class="card">
        <div id="discoveryError" style="display:none"></div>
        <div id="urlPlaceholder" class="hidden">
          <span class="spinner"></span><span>Discovering urls…</span>
        </div>
        <div id="urlCardsContainer">
        </div>
        <button id="addUrlBtn" />
      </div>
    </div>

    <div id="resultsSection" class="hidden"></div>
    <div id="listingsContainer"></div>
    <span id="resultCount"></span>
    <span id="totalCount"></span>
    <button id="toggleFilteredBtn"></button>
    <button id="deepBtn"></button>
    <textarea id="aiFilter"></textarea>

    <button id="searchTabBtn" class="active"></button>
    <button id="favouritesTabBtn"></button>
    <div id="searchTabPanel"></div>
    <div id="savedSearchesPanel" class="hidden"></div>
    <button id="saveCurrentBtn" class="hidden"></button>
  `;
  // The app always seeds one blank URL card on init (see app.ts) — every
  // caller of handleDiscoverySubmitAsync relies on urlCards[0] existing.
  createUrlCard(async () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows a discovering placeholder immediately, before the discover request resolves. then hides discovering placeholder, after the discover request resolves", async () => {
  urlCards[0].dom.input.value = "https://www.trademe.co.nz/stale";

  let resolveFetch!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );

  const submitPromise = handleDiscoverySubmitAsync();

  // Fetch hasn't resolved yet — assert on the mid-flight state.
  expect(
    document.getElementById("urlsCard")?.classList.contains("hidden"),
  ).toBe(false);
  expect(
    document.getElementById("urlCardsContainer")?.classList.contains("hidden"),
  ).toBe(true);
  expect(
    document.getElementById("addUrlBtn")?.classList.contains("hidden"),
  ).toBe(true);
  expect(
    document.getElementById("urlPlaceholder")?.classList.contains("hidden"),
  ).toBe(false);

  resolveFetch({
    ok: true,
    json: async () => ({ urls: ["https://www.trademe.co.nz/x"], name: "lamp" }),
  });
  await submitPromise;

  // Assert on the post-flight state.
  expect(
    document.getElementById("urlsCard")?.classList.contains("hidden"),
  ).toBe(false);
  expect(
    document.getElementById("urlCardsContainer")?.classList.contains("hidden"),
  ).toBe(false);
  expect(
    document.getElementById("addUrlBtn")?.classList.contains("hidden"),
  ).toBe(false);
  expect(
    document.getElementById("urlPlaceholder")?.classList.contains("hidden"),
  ).toBe(true);
  expect(
    document.getElementById("urlsSection")?.classList.contains("hidden"),
  ).toBe(false);
  expect(urlCards[0].dom.input.value).toBe("https://www.trademe.co.nz/x");
});

it("shows the discovery error and leaves the URL input blank when the discover request fails", async () => {
  urlCards[0].dom.input.value = "https://www.trademe.co.nz/stale";

  let resolveFetch!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );

  const submitPromise = handleDiscoverySubmitAsync();

  resolveFetch({
    ok: false,
    json: async () => ({ error: "No listings found" }),
  });
  await submitPromise;

  expect(document.getElementById("discoveryError")?.textContent).toBe(
    "No listings found",
  );
  expect(
    (document.getElementById("discoveryError") as HTMLDivElement).style.display,
  ).toBe("block");
  expect(urlCards[0].dom.input.value).toBe("");
  expect(
    document.getElementById("urlCardsContainer")?.classList.contains("hidden"),
  ).toBe(false);
  expect(
    document.getElementById("urlPlaceholder")?.classList.contains("hidden"),
  ).toBe(true);
});

it("clears any existing URL card value immediately when a new discovery is submitted, before the fetch resolves", async () => {
  urlCards[0].dom.input.value = "https://www.trademe.co.nz/stale";

  let resolveFetch!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );

  const submitPromise = handleDiscoverySubmitAsync();

  expect(urlCards).toHaveLength(1);
  expect(urlCards[0].dom.input.value).toBe("");

  resolveFetch({
    ok: true,
    json: async () => ({ urls: ["https://www.trademe.co.nz/x"], name: "lamp" }),
  });
  await submitPromise;
});

it("does not let a stale discovery response overwrite a saved search loaded while it was in flight", async () => {
  let resolveFetch!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );

  const submitPromise = handleDiscoverySubmitAsync();

  // Discovery is still in flight — placeholder showing, container hidden.
  expect(
    document.getElementById("urlCardsContainer")?.classList.contains("hidden"),
  ).toBe(true);

  // User loads a saved search before the discovery request resolves.
  await loadSavedSearchAsync({
    id: "saved-1",
    name: "saved search",
    urls: ["https://example.com/saved"],
    aiFilter: null,
    createdAt: 0,
  });

  // The saved search must be visible immediately, not stuck behind the placeholder.
  expect(
    document.getElementById("urlCardsContainer")?.classList.contains("hidden"),
  ).toBe(false);
  expect(urlCards[0].dom.input.value).toBe("https://example.com/saved");

  // The stale discovery now resolves successfully.
  resolveFetch({
    ok: true,
    json: async () => ({ urls: ["https://www.trademe.co.nz/stale"], name: "lamp" }),
  });
  await submitPromise;

  // It must not clobber the saved search the user is now looking at.
  expect(urlCards[0].dom.input.value).toBe("https://example.com/saved");
});
