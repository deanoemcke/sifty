import { describe, expect, it } from "vitest";
import type { Listing, ListingDetail } from "../lib/recipes/base";
import {
  buildCardMetaHtml,
  buildCardPriceHtml,
  buildDetailMetaHtml,
  buildDetailPriceHtml,
  buildExtrasHtml,
  cleanDescription,
  filterBannerText,
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
    ...overrides,
  };
}

function makeDetail(overrides: Partial<ListingDetail> = {}): ListingDetail {
  return {
    details: [],
    description: "",
    buyNowPrice: null,
    reserveStatus: "NONE",
    pickupAvailable: null,
    shippingAvailable: null,
    pickupLocation: "",
    questionsAndAnswers: [],
    ...overrides,
  };
}

function makeListingItem(overrides: Partial<ListingItem> = {}): ListingItem {
  return {
    data: makeListing(),
    detail: null,
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

describe("buildDetailPriceHtml", () => {
  it("shows the formatted price for non-auctions", () => {
    const html = buildDetailPriceHtml(
      makeListing({ price: 500 }),
      makeDetail({ buyNowPrice: 500 }),
    );
    expect(html).toContain("$500");
    expect(html).not.toContain("Buy Now");
  });

  it("adds a formatted buy-now price for auctions", () => {
    const html = buildDetailPriceHtml(
      makeListing({ price: 1000, isAuction: true }),
      makeDetail({ buyNowPrice: 1500 }),
    );
    expect(html).toContain(`Buy Now: <strong>$${(1500).toLocaleString()}</strong>`);
  });

  it("omits buy-now when the auction has none", () => {
    const html = buildDetailPriceHtml(makeListing({ isAuction: true }), makeDetail());
    expect(html).not.toContain("Buy Now");
  });

  it("shows 'Price on request' when price is null", () => {
    const html = buildDetailPriceHtml(makeListing({ price: null }), makeDetail());
    expect(html).toContain("Price on request");
  });
});

describe("buildDetailMetaHtml", () => {
  it("derives the reserve badge class from the status", () => {
    const html = buildDetailMetaHtml(
      makeListing({ isAuction: true }),
      makeDetail({ reserveStatus: "NOT_MET" }),
    );
    expect(html).toContain("badge-not-met");
    expect(html).toContain("Reserve not met");
  });

  it("shows no badge for non-auctions", () => {
    const html = buildDetailMetaHtml(makeListing(), makeDetail({ reserveStatus: "MET" }));
    expect(html).not.toContain("badge");
  });

  it("shows no badge for unknown reserve statuses", () => {
    const html = buildDetailMetaHtml(
      makeListing({ isAuction: true }),
      makeDetail({ reserveStatus: "UNKNOWN" }),
    );
    expect(html).toContain(`<span class="meta-right"></span>`);
  });
});

describe("buildExtrasHtml", () => {
  it("renders a details table when details exist", () => {
    const html = buildExtrasHtml(
      makeDetail({ details: [{ key: "Condition", value: "Used <good>" }] }),
    );
    expect(html).toContain("details-table");
    expect(html).toContain("Condition");
    expect(html).toContain("Used &lt;good&gt;");
  });

  it("omits the details table when empty", () => {
    expect(buildExtrasHtml(makeDetail())).not.toContain("details-table");
  });

  it("renders the cleaned, escaped description", () => {
    const html = buildExtrasHtml(makeDetail({ description: "nice & tidy\n\n\n\nend  " }));
    expect(html).toContain("nice &amp; tidy\n\nend");
  });

  it("falls back to an empty-description message", () => {
    expect(buildExtrasHtml(makeDetail())).toContain("No description provided.");
  });

  it("renders question and answer pairs, omitting missing answers", () => {
    const html = buildExtrasHtml(
      makeDetail({
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
    expect(buildExtrasHtml(makeDetail())).not.toContain("Questions");
  });
});
