// ── Listing detail (modal + deep search) ─────────────────────────────────────
// The detail modal and both deep-search flavours (single listing via the
// modal, bulk over visible results) are co-located: both fetch and display
// listing detail, and each renders into the other's surface.

import type { DeepSearchDetail } from "../lib/recipes/base";
import { requestAiFilterRun } from "./aiFilter";
import { decideModalDeepSearchAction } from "./deepSearchTrigger";
import { getElement } from "./domUtils";
import { esc } from "./html";
import {
  buildCardMetaHtml,
  buildCardPriceHtml,
  buildDetailMetaHtml,
  buildDetailPriceHtml,
  buildExtrasHtml,
} from "./listingHtml";
import { sourceBadgeHtml } from "./recipeDisplay";
import { applyClientFilters, getOrderedListings, renderDerived } from "./resultsView";
import {
  bulkDeepSearchUrls,
  deepSearchCancellationRequested,
  deepSearchId,
  isDeepSearchRunning,
  type ListingItem,
  listingsByUrl,
  openModalListingUrl,
  setBulkDeepSearchUrls,
  setDeepSearchCancellationRequested,
  setDeepSearchId,
  setIsDeepSearchRunning,
  setOpenModalListingUrl,
  singleDeepSearchInFlightUrls,
} from "./state";
import { setStatus } from "./statusBar";
import { streamPostAsync } from "./streamPost";

export function setDeepSearchingStatus(statusMessage: string): void {
  const statusBar = getElement("statusBar");
  statusBar.className = "status-bar info";
  statusBar.innerHTML = `<span class="spinner"></span><span>${esc(statusMessage)}</span>`;
  if (!deepSearchCancellationRequested) {
    const cancelButton = document.createElement("button");
    cancelButton.className = "cache-clear-btn";
    cancelButton.style.marginLeft = "0.5rem";
    cancelButton.textContent = "cancel";
    cancelButton.addEventListener("click", cancelDeepSearch);
    statusBar.appendChild(cancelButton);
  }
  statusBar.classList.remove("hidden");
}

export function cancelDeepSearch(): void {
  if (!isDeepSearchRunning || deepSearchCancellationRequested) return;
  setDeepSearchCancellationRequested(true);
  setDeepSearchingStatus("Cancelling…");
  fetch("/api/cancel-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ searchId: deepSearchId }),
  }).catch(() => null);
}

export function setDeepSearchBusy(busy: boolean): void {
  setIsDeepSearchRunning(busy);
  renderDerived();
}

// ── Listing detail modal ──────────────────────────────────────────────────────

export function listingModalExtrasHtml(item: ListingItem, errorMessage: string | null): string {
  if (errorMessage) return `<p class="deep-empty">Couldn't load details — ${esc(errorMessage)}</p>`;
  if (item.hasBeenDeepSearched) return buildExtrasHtml(item.data);
  return `<div class="modal-loading"><span class="spinner"></span><span>Fetching details…</span></div>`;
}

export function renderListingModalContent(
  item: ListingItem,
  errorMessage: string | null = null,
): void {
  // A previous single-listing fetch may resolve after the modal has closed
  // or moved on to a different listing — ignore stale writes.
  if (openModalListingUrl !== item.data.url) return;

  const listing = item.data;
  const thumb = listing.thumbnailUrl
    ? `<img class="listing-modal-thumb" src="${esc(listing.thumbnailUrl)}" alt="">`
    : `<div class="listing-modal-thumb-placeholder"></div>`;
  const metaHtml = item.hasBeenDeepSearched
    ? buildDetailMetaHtml(listing)
    : buildCardMetaHtml(listing);
  const priceHtml = item.hasBeenDeepSearched
    ? buildDetailPriceHtml(listing)
    : buildCardPriceHtml(listing);

  getElement("listingModalBody").innerHTML = `
    <div class="listing-modal-header">
      <div class="listing-modal-thumb-wrap">${thumb}${sourceBadgeHtml(listing.source, 32)}</div>
      <div class="listing-modal-heading">
        <div class="listing-modal-title">${esc(listing.title)}</div>
        <div class="listing-meta">${metaHtml}</div>
        <div class="listing-prices">${priceHtml}</div>
        <a class="listing-modal-original-link" href="${esc(listing.url)}" target="_blank" rel="noopener">View original listing ↗</a>
      </div>
    </div>
    <div class="listing-modal-extras">${listingModalExtrasHtml(item, errorMessage)}</div>
  `;
}

export function applyDeepSearchDetail(item: ListingItem, detail: DeepSearchDetail): void {
  item.hasBeenDeepSearched = true;
  Object.assign(item.data, detail);
  item.aiCheckedHash = null;
  if (openModalListingUrl === item.data.url) renderListingModalContent(item);
}

export async function deepSearchListingAsync(item: ListingItem): Promise<void> {
  const url = item.data.url;
  singleDeepSearchInFlightUrls.add(url);
  try {
    await streamPostAsync(
      "/api/deep-search",
      { listings: [item.data], deepSearchId: crypto.randomUUID() },
      (ev) => {
        if (ev.type === "detail") {
          applyDeepSearchDetail(item, ev.detail as DeepSearchDetail);
          renderDerived();
        } else if (ev.type === "detail-error" || ev.type === "error") {
          renderListingModalContent(item, ev.message as string);
        }
      },
    );
  } catch (error) {
    renderListingModalContent(item, (error as Error).message);
  } finally {
    singleDeepSearchInFlightUrls.delete(url);
  }
  if (item.hasBeenDeepSearched) {
    applyClientFilters();
    const aiPrompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
    if (aiPrompt) requestAiFilterRun();
  }
}

export async function openListingModalAsync(item: ListingItem): Promise<void> {
  setOpenModalListingUrl(item.data.url);
  getElement("listingModal").classList.remove("hidden");
  renderListingModalContent(item);
  const action = decideModalDeepSearchAction({
    hasBeenDeepSearched: item.hasBeenDeepSearched,
    isCoveredByBulkSearch: bulkDeepSearchUrls?.has(item.data.url) ?? false,
    isAlreadyFetchingSingle: singleDeepSearchInFlightUrls.has(item.data.url),
  });
  if (action === "start") await deepSearchListingAsync(item);
}

export function closeListingModal(): void {
  getElement("listingModal").classList.add("hidden");
  setOpenModalListingUrl(null);
}

// ── Bulk deep search ──────────────────────────────────────────────────────────

export async function runDeepSearchAsync(): Promise<void> {
  const toScrape = getOrderedListings()
    .filter(
      (item) =>
        !item.hasBeenDeepSearched &&
        item.aiFilterReason === null &&
        !singleDeepSearchInFlightUrls.has(item.data.url),
    )
    .map((item) => item.data);

  if (toScrape.length === 0) return;

  setDeepSearchId(crypto.randomUUID());
  setDeepSearchCancellationRequested(false);
  setDeepSearchBusy(true);
  setBulkDeepSearchUrls(new Set(toScrape.map((listing) => listing.url)));
  let detailsReceived = 0;

  setDeepSearchingStatus(
    `Fetching details for ${toScrape.length} listing${toScrape.length !== 1 ? "s" : ""}…`,
  );

  try {
    await streamPostAsync("/api/deep-search", { listings: toScrape, deepSearchId }, (ev) => {
      if (ev.type === "progress") {
        if (!deepSearchCancellationRequested)
          setDeepSearchingStatus(
            `Fetching details ${ev.index}/${ev.total} — ${String(ev.title).slice(0, 55)}…`,
          );
      } else if (ev.type === "detail") {
        detailsReceived++;
        const item = listingsByUrl.get(ev.url as string);
        if (item) applyDeepSearchDetail(item, ev.detail as DeepSearchDetail);
        renderDerived();
      } else if (ev.type === "detail-error") {
        console.warn(`[deep-search] failed for ${ev.url}: ${ev.message}`);
      } else if (ev.type === "complete") {
        setStatus("Deep search complete", "success");
        setTimeout(() => setStatus(null), 4000);
      } else if (ev.type === "error") {
        setStatus(ev.message as string, "error");
      }
    });
  } catch (error) {
    setStatus((error as Error).message, "error");
  }

  setBulkDeepSearchUrls(null);

  if (deepSearchCancellationRequested) {
    setStatus(
      `Cancelled — ${detailsReceived}/${toScrape.length} detail${toScrape.length !== 1 ? "s" : ""} loaded`,
      "error",
    );
  }

  setDeepSearchId(null);
  setDeepSearchCancellationRequested(false);
  setDeepSearchBusy(false);
  applyClientFilters();
  const aiPrompt = getElement<HTMLTextAreaElement>("aiFilter").value.trim();
  if (aiPrompt) requestAiFilterRun();
}

// Clicking anywhere on a listing card — or pressing Enter/Space on a
// focused one — opens its detail modal, deep searching it first if it
// hasn't been already.
export function openListingCardModal(card: HTMLElement): void {
  const url = card.dataset.url;
  if (!url) throw new Error("listing-card missing data-url attribute");
  const item = listingsByUrl.get(url);
  if (!item) throw new Error(`listingsByUrl missing entry for ${url}`);
  void openListingModalAsync(item);
}
