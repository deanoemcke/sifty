// ── Listing HTML fragments ────────────────────────────────────────────────────
// Pure string builders shared by the results grid card and the detail modal.
// All interpolated text goes through esc(); no DOM access here.

import type { Listing } from "../lib/recipes/base";
import { esc } from "./html";
import { formatListingPrice } from "./priceFormat";
import type { ListingItem } from "./state";

export function filterBannerText(item: ListingItem): string {
  return item.aiFilterReason ? `Filtered: ${item.aiFilterReason}` : "Filtered";
}

export function formatReserveText(status: string): string {
  if (status === "NONE") return "No reserve";
  if (status === "MET") return "Reserve met";
  if (status === "NOT_MET") return "Reserve not met";
  return "";
}

export function cleanDescription(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildCardPriceHtml(listing: Listing): string {
  return `<span class="price">${esc(formatListingPrice(listing.price))}</span>`;
}

export function buildCardMetaHtml(listing: Listing): string {
  return `<span class="meta-left"><span class="meta-text">${esc(listing.location)}</span></span><span class="meta-right"></span>`;
}

export function buildDetailPriceHtml(listing: Listing): string {
  let html = `<span class="price">${esc(formatListingPrice(listing.price))}</span>`;
  const buyNowPrice = listing.buyNowPrice;
  if (listing.isAuction && buyNowPrice != null) {
    html += `<span class="price-buynow">Buy Now: <strong>$${buyNowPrice.toLocaleString()}</strong></span>`;
  }
  return html;
}

export function buildDetailMetaHtml(listing: Listing): string {
  const left = `<span class="meta-left"><span class="meta-text">${esc(listing.location)}</span></span>`;
  let html = "";
  if (listing.isAuction) {
    const reserveStatus = listing.reserveStatus ?? "";
    const reserve = formatReserveText(reserveStatus);
    if (reserve)
      html += `<span class="badge badge-${reserveStatus.toLowerCase().replace("_", "-")}">${esc(reserve)}</span>`;
  }
  return `${left}<span class="meta-right">${html}</span>`;
}

export function buildExtrasHtml(listing: Listing): string {
  let body = "";

  // ── Details ───────────────────────────────────────────────────────────────
  const detailEntries = Object.entries(listing.scrapedAttributes ?? {});
  if (detailEntries.length > 0) {
    body += `<div class="deep-section">
      <div class="deep-section-label">Details</div>
      <div class="details-table">${detailEntries
        .map(
          ([key, value]) =>
            `<span class="details-key">${esc(key)}</span><span class="details-val">${esc(value)}</span>`,
        )
        .join("")}</div>
    </div>`;
  }

  // ── Description ───────────────────────────────────────────────────────────
  body += `<div class="deep-section"><div class="deep-section-label">Description</div>`;
  if (listing.description) {
    body += `<div class="listing-description">${esc(cleanDescription(listing.description))}</div>`;
  } else {
    body += `<p class="deep-empty">No description provided.</p>`;
  }
  body += `</div>`;

  // ── Questions & Answers ───────────────────────────────────────────────────
  const questionsAndAnswers = listing.questionsAndAnswers ?? [];
  if (questionsAndAnswers.length > 0) {
    body += `<div class="deep-section"><div class="deep-section-label">Questions &amp; Answers</div>`;
    body += questionsAndAnswers
      .map(
        ({ question, answer }) =>
          `<div class="qa-pair">` +
          `<div class="qa-item"><span class="qa-badge qa-q">Q</span><span class="qa-text">${esc(question)}</span></div>` +
          (answer
            ? `<div class="qa-item"><span class="qa-badge qa-a">A</span><span class="qa-text">${esc(answer)}</span></div>`
            : "") +
          `</div>`,
      )
      .join("");
    body += `</div>`;
  }

  return body;
}
