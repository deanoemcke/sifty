// ── Listing HTML fragments ────────────────────────────────────────────────────
// Pure string builders shared by the results grid card and the detail modal.
// All interpolated text goes through esc(); no DOM access here.

import { formatListingPrice } from '../lib/priceFormat';
import type { Listing } from '../lib/recipes/base';
import { esc } from './html';
import type { ListingItem } from './state';

export function filterBannerText(item: ListingItem): string {
  return item.aiFilterReason ? `Filtered: ${item.aiFilterReason}` : 'Filtered';
}

export function formatReserveText(status: string): string {
  if (status === 'NONE') return 'No reserve';
  if (status === 'MET') return 'Reserve met';
  if (status === 'NOT_MET') return 'Reserve not met';
  return '';
}

export function cleanDescription(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// Formats in UTC (not local time) so the same ISO input renders identically
// regardless of the machine running it.
export function formatListingDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTH_ABBREVIATIONS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function buildCardPriceHtml(listing: Listing): string {
  return `<span class="price">${esc(formatListingPrice(listing.price))}</span>`;
}

export function buildCardMetaHtml(listing: Listing): string {
  return `<span class="meta-left"><span class="meta-text">${esc(listing.location)}</span></span><span class="meta-right"></span>`;
}

const EXTERNAL_LINK_ICON = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

// Single source of truth for the external-link button's class name: used
// here to build the markup and by listingCardActivation.ts to detect
// clicks/keypresses on it so they navigate instead of also opening the
// modal underneath.
export const EXTERNAL_LINK_BUTTON_CLASS_NAME = 'listing-external-link-btn';

// Rendered as a sibling of .listing-open-area (not nested inside it) so a
// focusable <a> never ends up inside the card's role="button" wrapper.
export function buildExternalLinkButtonHtml(url: string): string {
  return `<a class="${EXTERNAL_LINK_BUTTON_CLASS_NAME}" href="${esc(url)}" target="_blank" rel="noopener" title="Open original listing" aria-label="Open original listing">${EXTERNAL_LINK_ICON}</a>`;
}

// Card footer row: the location on the left, the price on the right.
export function buildCardFooterHtml(listing: Listing): string {
  return `<span class="meta-left"><span class="meta-text">${esc(listing.location)}</span></span><span class="meta-right">${buildCardPriceHtml(listing)}</span>`;
}

export function buildDetailPriceHtml(listing: Listing): string {
  let html = `<span class="price">${esc(formatListingPrice(listing.price))}</span>`;
  const buyNowPrice = listing.buyNowPrice;
  if (listing.isAuction && buyNowPrice != null) {
    html += `<span class="price-buynow">Buy Now: <strong>$${Math.round(buyNowPrice).toLocaleString()}</strong></span>`;
  }
  return html;
}

export function buildDetailMetaHtml(listing: Listing): string {
  const left = `<span class="meta-left"><span class="meta-text">${esc(listing.location)}</span></span>`;
  let html = '';
  if (listing.isAuction) {
    const reserveStatus = listing.reserveStatus ?? '';
    const reserve = formatReserveText(reserveStatus);
    if (reserve)
      html += `<span class="badge badge-${reserveStatus.toLowerCase().replace('_', '-')}">${esc(reserve)}</span>`;
  }
  return `${left}<span class="meta-right">${html}</span>`;
}

function buildQaAttributionHtml(name: string | undefined, iso: string | undefined): string {
  const parts: string[] = [];
  if (name) parts.push(esc(name));
  if (iso) parts.push(esc(formatListingDate(iso)));
  return parts.length > 0 ? `<span class="qa-meta">${parts.join(', ')}</span>` : '';
}

function buildShippingRowHtml(
  shippingAvailable: boolean | null | undefined,
  shippingCost: number | null | undefined
): string {
  if (shippingAvailable === undefined) return '';
  const value = !shippingAvailable
    ? 'Not available'
    : shippingCost != null
      ? esc(formatListingPrice(shippingCost))
      : 'Available (cost unknown)';
  return `<span class="details-key">Shipping</span><span class="details-val">${value}</span>`;
}

function buildPickupRowHtml(
  pickupAvailable: boolean | null | undefined,
  pickupLocation: string | null | undefined
): string {
  if (pickupAvailable === undefined) return '';
  const value = !pickupAvailable ? 'Not available' : esc(pickupLocation ?? 'Available');
  return `<span class="details-key">Pickup</span><span class="details-val">${value}</span>`;
}

function buildPhotoGalleryHtml(photos: Listing['photos']): string {
  const photoList = photos ?? [];
  if (photoList.length === 0) return '';
  return `<div class="deep-section">
      <div class="deep-section-label">Photos</div>
      <div class="photo-gallery">${photoList
        .map(
          ({ thumbnailUrl, fullSizeUrl }) =>
            `<a href="${esc(fullSizeUrl)}" target="_blank" rel="noopener"><img class="photo-gallery-thumb" src="${esc(thumbnailUrl)}" alt=""></a>`
        )
        .join('')}</div>
    </div>`;
}

function buildListingInfoHtml(listing: Listing): string {
  const listingInfoRows = [
    listing.startDate
      ? `<span class="details-key">Started</span><span class="details-val">${esc(formatListingDate(listing.startDate))}</span>`
      : '',
    listing.endDate
      ? `<span class="details-key">Ends</span><span class="details-val">${esc(formatListingDate(listing.endDate))}</span>`
      : '',
    listing.categoryPath
      ? `<span class="details-key">Category</span><span class="details-val">${esc(listing.categoryPath)}</span>`
      : '',
  ].filter(Boolean);
  if (listingInfoRows.length === 0) return '';
  return `<div class="deep-section">
      <div class="deep-section-label">Listing info</div>
      <div class="details-table">${listingInfoRows.join('')}</div>
    </div>`;
}

export function buildExtrasHtml(listing: Listing): string {
  let body = '';

  // ── Photos ────────────────────────────────────────────────────────────────
  body += buildPhotoGalleryHtml(listing.photos);

  // ── Listing info (dates, category) ──────────────────────────────────────
  body += buildListingInfoHtml(listing);

  // ── Shipping & pickup ────────────────────────────────────────────────────
  const shippingRow = buildShippingRowHtml(listing.shippingAvailable, listing.shippingCost);
  const pickupRow = buildPickupRowHtml(listing.pickupAvailable, listing.pickupLocation);
  if (shippingRow || pickupRow) {
    body += `<div class="deep-section">
      <div class="deep-section-label">Shipping &amp; pickup</div>
      <div class="details-table">${shippingRow}${pickupRow}</div>
    </div>`;
  }

  // ── Details ───────────────────────────────────────────────────────────────
  const detailEntries = Object.entries(listing.extraAttributes ?? {});
  if (detailEntries.length > 0) {
    body += `<div class="deep-section">
      <div class="deep-section-label">Details</div>
      <div class="details-table">${detailEntries
        .map(
          ([key, value]) =>
            `<span class="details-key">${esc(key)}</span><span class="details-val">${esc(value)}</span>`
        )
        .join('')}</div>
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
        ({ question, answer, askedBy, askedAt, answeredAt }) =>
          `<div class="qa-pair">` +
          `<div class="qa-item"><span class="qa-badge qa-q">Q</span><span class="qa-text">${esc(question)}</span>${buildQaAttributionHtml(askedBy, askedAt)}</div>` +
          (answer
            ? `<div class="qa-item"><span class="qa-badge qa-a">A</span><span class="qa-text">${esc(answer)}</span>${buildQaAttributionHtml(undefined, answeredAt)}</div>`
            : '') +
          `</div>`
      )
      .join('');
    body += `</div>`;
  }

  return body;
}
