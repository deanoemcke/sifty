// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDiscoverySubmitAsync } from "./searchSession";

beforeEach(() => {
  document.body.innerHTML = `
    <textarea id="discoveryPrompt">lamp</textarea>
    <input id="discoveryMaxPrice" />
    <input id="discoveryAllowShipping" type="checkbox" />
    <select id="discoveryRegion"><option value="">Any</option></select>
    <button id="discoveryBtn"></button>
    <div id="discoveryError" style="display:none"></div>

    <div id="urlsSection" class="hidden">
      <div id="urlsCard" class="card">
        <div id="urlPlaceholder" class="hidden">
          <span class="spinner"></span><span>Discovering urls…</span>
        </div>
        <div id="urlCardsContainer">
        </div>
        <button id="addUrlBtn" />
      </div>
    </div>
  `;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows a discovering placeholder immediately, before the discover request resolves. then hides discovering placeholder, after the discover request resolves", async () => {
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
  
});
