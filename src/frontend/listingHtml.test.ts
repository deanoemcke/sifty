import { describe, expect, it } from "vitest";
import type { Listing } from "../lib/recipes/base";
import {
  buildCardFooterHtml,
  buildCardMetaHtml,
  buildCardPriceHtml,
  buildDetailMetaHtml,
  buildDetailPriceHtml,
  buildExternalLinkButtonHtml,
  buildExtrasHtml,
  cleanDescription,
  filterBannerText,
  formatListingDate,
  formatReserveText,
} from "./listingHtml";
import type { ListingItem } from "./state";

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "trademe",
    title: "Test listing",
    price: 100,
    location: "Wellington",
    url: "https://example.com/listing/1",
    isAuction: false,
    ...overrides,
  };
}

function makeListingItem(overrides: Partial<ListingItem> = {}): ListingItem {
  return {
    data: makeListing(),
    hasBeenDeepSearched: false,
    aiCheckedHash: null,
    aiFilterReason: null,
    ...overrides,
  };
}

describe("formatReserveText", () => {
  it("maps each reserve status to its label", () => {
    expect(formatReserveText("NONE")).toBe("No reserve");
    expect(formatReserveText("MET")).toBe("Reserve met");
    expect(formatReserveText("NOT_MET")).toBe("Reserve not met");
  });

  it("returns empty string for unknown statuses", () => {
    expect(formatReserveText("UNKNOWN")).toBe("");
    expect(formatReserveText("")).toBe("");
  });
});

describe("cleanDescription", () => {
  it("strips trailing whitespace per line", () => {
    expect(cleanDescription("line one   \nline two\t")).toBe("line one\nline two");
  });

  it("collapses three or more newlines to two", () => {
    expect(cleanDescription("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims the overall result", () => {
    expect(cleanDescription("\n\n  text  \n\n")).toBe("text");
  });
});

describe("filterBannerText", () => {
  it("includes the AI reason when present", () => {
    const item = makeListingItem({ aiFilterReason: "too expensive" });
    expect(filterBannerText(item)).toBe("Filtered: too expensive");
  });

  it("falls back to a plain label without a reason", () => {
    expect(filterBannerText(makeListingItem())).toBe("Filtered");
  });
});

describe("buildCardPriceHtml", () => {
  it("formats a normal price with $ and thousands separator", () => {
    const html = buildCardPriceHtml(makeListing({ price: 1500 }));
    expect(html).toContain(`$1,500`);
  });

  it("shows 'Free' for zero price", () => {
    const html = buildCardPriceHtml(makeListing({ price: 0 }));
    expect(html).toContain("Free");
  });

  it("shows 'Price on request' for null price", () => {
    const html = buildCardPriceHtml(makeListing({ price: null }));
    expect(html).toContain("Price on request");
  });

  it("escapes special characters in formatted output", () => {
    const html = buildCardPriceHtml(makeListing({ price: 100 }));
    expect(html).toContain(`<span class="price">$100</span>`);
  });
});

describe("buildCardMetaHtml", () => {
  it("escapes the location", () => {
    const html = buildCardMetaHtml(makeListing({ location: "A & B" }));
    expect(html).toContain("A &amp; B");
    expect(html).toContain("meta-left");
    expect(html).toContain("meta-right");
  });
});

describe("buildExternalLinkButtonHtml", () => {
  it("links to the escaped listing url", () => {
    const html = buildExternalLinkButtonHtml('https://example.com/1?a=1&b="x"');
    expect(html).toContain("listing-external-link-btn");
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('"x"');
  });
});

describe("buildCardFooterHtml", () => {
  it("contains only the location and price, not the external-link button", () => {
    const html = buildCardFooterHtml(makeListing({ location: "Auckland", price: 250 }));
    expect(html).toContain("Auckland");
    expect(html).toContain("$250");
    expect(html).not.toContain("listing-external-link-btn");
  });
});

describe("buildDetailPriceHtml", () => {
  it("shows the formatted price for non-auctions", () => {
    const html = buildDetailPriceHtml(makeListing({ price: 500, buyNowPrice: 500 }));
    expect(html).toContain("$500");
    expect(html).not.toContain("Buy Now");
  });

  it("adds a formatted buy-now price for auctions", () => {
    const html = buildDetailPriceHtml(
      makeListing({ price: 1000, isAuction: true, buyNowPrice: 1500 }),
    );
    expect(html).toContain(`Buy Now: <strong>$${(1500).toLocaleString()}</strong>`);
  });

  it("rounds the buy-now price to the nearest whole dollar", () => {
    const html = buildDetailPriceHtml(
      makeListing({ price: 1000, isAuction: true, buyNowPrice: 1500.5 }),
    );
    expect(html).toContain(`Buy Now: <strong>$${(1501).toLocaleString()}</strong>`);
  });

  it("omits buy-now when the auction has none", () => {
    const html = buildDetailPriceHtml(makeListing({ isAuction: true }));
    expect(html).not.toContain("Buy Now");
  });

  it("shows 'Price on request' when price is null", () => {
    const html = buildDetailPriceHtml(makeListing({ price: null }));
    expect(html).toContain("Price on request");
  });
});

describe("buildDetailMetaHtml", () => {
  it("derives the reserve badge class from the status", () => {
    const html = buildDetailMetaHtml(makeListing({ isAuction: true, reserveStatus: "NOT_MET" }));
    expect(html).toContain("badge-not-met");
    expect(html).toContain("Reserve not met");
  });

  it("shows no badge for non-auctions", () => {
    const html = buildDetailMetaHtml(makeListing({ reserveStatus: "MET" }));
    expect(html).not.toContain("badge");
  });

  it("shows no badge for unknown reserve statuses", () => {
    const html = buildDetailMetaHtml(makeListing({ isAuction: true, reserveStatus: "UNKNOWN" }));
    expect(html).toContain(`<span class="meta-right"></span>`);
  });
});

describe("buildExtrasHtml", () => {
  it("renders a details table when details exist", () => {
    const html = buildExtrasHtml(makeListing({ extraAttributes: { Condition: "Used <good>" } }));
    expect(html).toContain("details-table");
    expect(html).toContain("Condition");
    expect(html).toContain("Used &lt;good&gt;");
  });

  it("omits the details table when empty", () => {
    expect(buildExtrasHtml(makeListing())).not.toContain("details-table");
  });

  it("does not read structured fields (buyNowPrice, reserveStatus, etc.) from extraAttributes", () => {
    const html = buildExtrasHtml(
      makeListing({
        buyNowPrice: 500,
        reserveStatus: "MET",
        extraAttributes: { Condition: "Used" },
      }),
    );
    expect(html).toContain("details-table");
    expect(html).toContain("Condition");
    expect(html).not.toContain("500");
  });

  it("renders a scraped attribute even if its key happens to match a known field name", () => {
    const html = buildExtrasHtml(
      makeListing({ reserveStatus: "MET", extraAttributes: { reserveStatus: "As scraped" } }),
    );
    expect(html).toContain("As scraped");
  });

  it("renders the cleaned, escaped description", () => {
    const html = buildExtrasHtml(makeListing({ description: "nice & tidy\n\n\n\nend  " }));
    expect(html).toContain("nice &amp; tidy\n\nend");
  });

  it("falls back to an empty-description message", () => {
    expect(buildExtrasHtml(makeListing())).toContain("No description provided.");
  });

  it("renders question and answer pairs, omitting missing answers", () => {
    const html = buildExtrasHtml(
      makeListing({
        questionsAndAnswers: [
          { question: "Works?", answer: "Yes" },
          { question: "Ships?", answer: "" },
        ],
      }),
    );
    expect(html).toContain("Questions &amp; Answers");
    expect((html.match(/qa-q/g) ?? []).length).toBe(2);
    expect((html.match(/qa-a/g) ?? []).length).toBe(1);
  });

  it("omits the Q&A section when there are no questions", () => {
    expect(buildExtrasHtml(makeListing())).not.toContain("Questions");
  });

  it("renders asker and formatted dates alongside question/answer text", () => {
    const html = buildExtrasHtml(
      makeListing({
        questionsAndAnswers: [
          {
            question: "Backlit?",
            answer: "Yes",
            askedBy: "karlo",
            askedAt: "2026-07-05T10:33:18.060Z",
            answeredAt: "2026-07-05T10:45:53.627Z",
          },
        ],
      }),
    );
    expect(html).toContain("karlo");
    expect(html).toContain("5 Jul 2026");
  });

  it("renders an unanswered, anonymous question without leaking 'undefined'", () => {
    const html = buildExtrasHtml(
      makeListing({
        questionsAndAnswers: [{ question: "Any warranty?", answer: "" }],
      }),
    );
    expect(html).not.toContain("undefined");
    expect((html.match(/qa-a/g) ?? []).length).toBe(0);
  });

  it("renders a photo gallery linking each thumbnail to its full-size image", () => {
    const html = buildExtrasHtml(
      makeListing({
        photos: [
          {
            thumbnailUrl: "https://example.com/thumb1.jpg",
            fullSizeUrl: "https://example.com/full1.jpg",
          },
          {
            thumbnailUrl: "https://example.com/thumb2.jpg",
            fullSizeUrl: "https://example.com/full2.jpg",
          },
        ],
      }),
    );
    expect(html).toContain("photo-gallery");
    expect((html.match(/<img/g) ?? []).length).toBe(2);
    expect(html).toContain(`href="https://example.com/full1.jpg"`);
    expect(html).toContain(`src="https://example.com/thumb2.jpg"`);
    expect(html).toContain('target="_blank"');
  });

  it("escapes photo URLs", () => {
    const html = buildExtrasHtml(
      makeListing({
        photos: [
          {
            thumbnailUrl: 'https://example.com/a"b.jpg',
            fullSizeUrl: "https://example.com/full.jpg",
          },
        ],
      }),
    );
    expect(html).not.toContain('a"b.jpg');
  });

  it("omits the photo gallery when there are no photos", () => {
    expect(buildExtrasHtml(makeListing())).not.toContain("photo-gallery");
  });

  it("renders listing dates and category path", () => {
    const html = buildExtrasHtml(
      makeListing({
        startDate: "2026-07-01T10:00:00.000Z",
        endDate: "2026-07-08T10:00:00.000Z",
        categoryPath: "/Computers/Laptops/Laptops/Lenovo",
      }),
    );
    expect(html).toContain("1 Jul 2026");
    expect(html).toContain("8 Jul 2026");
    expect(html).toContain("/Computers/Laptops/Laptops/Lenovo");
  });

  it("renders only the dates that are present, without leaking 'undefined'", () => {
    const html = buildExtrasHtml(makeListing({ startDate: "2026-07-01T10:00:00.000Z" }));
    expect(html).toContain("1 Jul 2026");
    expect(html).not.toContain("undefined");
  });

  it("omits the listing-info section when no dates or category are present", () => {
    const html = buildExtrasHtml(makeListing());
    expect(html).not.toContain("Listing info");
  });

  it("renders shipping and pickup availability with cost/location", () => {
    const html = buildExtrasHtml(
      makeListing({
        shippingAvailable: true,
        shippingCost: 15,
        pickupAvailable: true,
        pickupLocation: "Invercargill, Southland",
      }),
    );
    expect(html).toContain("$15");
    expect(html).toContain("Invercargill, Southland");
  });

  it("shows shipping/pickup as explicitly not available rather than omitting the row", () => {
    const html = buildExtrasHtml(makeListing({ shippingAvailable: false, pickupAvailable: false }));
    expect(html).toContain("Not available");
  });

  it("shows an explicit 'cost unknown' when shipping is available but cost is null", () => {
    const html = buildExtrasHtml(makeListing({ shippingAvailable: true, shippingCost: null }));
    expect(html).toContain("cost unknown");
    expect(html).not.toContain("$null");
  });

  it("omits the shipping & pickup section when deep search hasn't populated those fields", () => {
    expect(buildExtrasHtml(makeListing())).not.toContain("Shipping");
  });
});

describe("formatListingDate", () => {
  it("formats an ISO date as 'D MMM YYYY' in UTC", () => {
    expect(formatListingDate("2026-07-05T10:33:18.060Z")).toBe("5 Jul 2026");
  });

  it("is stable regardless of time-of-day component", () => {
    expect(formatListingDate("2026-01-01T23:59:59.000Z")).toBe("1 Jan 2026");
  });
});
