import { describe, expect, it, vi } from "vitest";
import { buildFacebookListing, buildFacebookUrl, facebookRecipe, parseFacebookPriceLines } from "./facebook";

const TEST_REGIONS = [
  { name: "Auckland", tradeMeRegionId: 2, facebookLocation: "auckland" },
  { name: "Wellington", tradeMeRegionId: 12, facebookLocation: "wellington" },
];

// This mock is load-bearing for buildDiscoverUrlsAsync tests below, which rely on
// buildFacebookUrl's default `regions` argument being supplied by the mocked getRegions.
vi.mock("../services/regions", () => ({ getRegions: () => TEST_REGIONS }));

describe("parseFacebookPriceLines", () => {
  it("returns the single price when only one price line is present", () => {
    const result = parseFacebookPriceLines("Vintage lamp\nNZ$80\nAuckland");
    expect(result.priceDisplay).toBe("NZ$80");
    expect(result.price).toBe(80);
  });

  it("discards the original (crossed-out) price when two prices are present, using only the current price", () => {
    // Facebook shows the sale price first and the original price second.
    // Product decision: we surface only the current price; the original is not stored or displayed.
    const result = parseFacebookPriceLines("Nice chair\nNZ$80\nNZ$120\nWellington");
    expect(result.priceDisplay).toBe("NZ$80");
    expect(result.price).toBe(80);
    expect(result.priceDisplay).not.toContain("120");
    expect(result.priceDisplay).not.toContain("<s>");
  });

  it("returns Price on request when no price is present", () => {
    const result = parseFacebookPriceLines("Mystery item\nAuckland");
    expect(result.priceDisplay).toBe("Price on request");
    expect(result.price).toBeNull();
  });

  it("handles Free correctly", () => {
    const result = parseFacebookPriceLines("Free sofa\nFree\nChristchurch");
    expect(result.priceDisplay).toBe("Free");
    expect(result.price).toBeNull();
  });

  it("parses prices with commas", () => {
    const result = parseFacebookPriceLines("Car\nNZ$1,200\nDunedin");
    expect(result.priceDisplay).toBe("NZ$1,200");
    expect(result.price).toBe(1200);
  });

  it("handles empty innerText gracefully", () => {
    const result = parseFacebookPriceLines("");
    expect(result.price).toBeNull();
    expect(result.priceDisplay).toBe("Price on request");
  });

  it("handles whitespace-only innerText gracefully", () => {
    const result = parseFacebookPriceLines("  \n  \n  ");
    expect(result.price).toBeNull();
    expect(result.priceDisplay).toBe("Price on request");
  });

  it("returns normalised lines for caller reuse", () => {
    const result = parseFacebookPriceLines("Vintage lamp\nNZ$80\nAuckland");
    expect(result.lines).toEqual(["Vintage lamp", "NZ$80", "Auckland"]);
  });
});

// ── buildFacebookUrl ──────────────────────────────────────────────────────────

describe("buildFacebookUrl", () => {
  it("always sets query, exact, and sortBy", () => {
    const url = buildFacebookUrl("macbook", 0, "any", undefined, TEST_REGIONS);
    expect(url).toContain("query=macbook");
    expect(url).toContain("exact=false");
    expect(url).toContain("sortBy=creation_time_descend");
  });

  it("adds maxPrice when > 0", () => {
    const url = buildFacebookUrl("macbook", 800, "any", undefined, TEST_REGIONS);
    expect(url).toContain("maxPrice=800");
  });

  it("omits maxPrice when 0", () => {
    const url = buildFacebookUrl("macbook", 0, "any", undefined, TEST_REGIONS);
    expect(url).not.toContain("maxPrice");
  });

  it("sets deliveryMethod=local_pick_up for pickup fulfillment", () => {
    const url = buildFacebookUrl("macbook", 0, "pickup", undefined, TEST_REGIONS);
    expect(url).toContain("deliveryMethod=local_pick_up");
  });

  it("sets deliveryMethod=shipping for shipping fulfillment", () => {
    const url = buildFacebookUrl("macbook", 0, "shipping", undefined, TEST_REGIONS);
    expect(url).toContain("deliveryMethod=shipping");
  });

  it('omits deliveryMethod for "any" fulfillment', () => {
    const url = buildFacebookUrl("macbook", 0, "any", undefined, TEST_REGIONS);
    expect(url).not.toContain("deliveryMethod");
  });

  it("injects location segment when pickup and regionValue matches a region", () => {
    const url = buildFacebookUrl("macbook", 0, "pickup", "2", TEST_REGIONS);
    expect(url).toContain("/marketplace/auckland/search");
  });

  it("omits location segment when pickup but regionValue is undefined", () => {
    const url = buildFacebookUrl("macbook", 0, "pickup", undefined, TEST_REGIONS);
    expect(url).toContain("/marketplace/search");
    expect(url).not.toContain("/marketplace/auckland/");
  });

  it('omits location segment when fulfillment is "any" even with regionValue', () => {
    const url = buildFacebookUrl("macbook", 0, "any", "2", TEST_REGIONS);
    expect(url).not.toContain("/marketplace/auckland/");
  });

  it("omits location segment when regionValue does not match any region", () => {
    const url = buildFacebookUrl("macbook", 0, "pickup", "999", TEST_REGIONS);
    expect(url).toContain("/marketplace/search");
    expect(url).not.toContain("/marketplace/undefined/");
  });
});

// ── buildDiscoverUrlsAsync ────────────────────────────────────────────────────

const MOCK_AI_CONFIG = { url: "http://example.com", model: "llama", apiKey: "key" };

describe("buildDiscoverUrlsAsync", () => {
  it("returns a single Facebook Marketplace URL", async () => {
    const result = await facebookRecipe.buildDiscoverUrlsAsync("macbook pro", {
      maxPrice: 0,
      fulfillment: "any",
      aiConfig: MOCK_AI_CONFIG,
    });
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain("facebook.com/marketplace");
  });

  it("includes the prompt as the search query", async () => {
    const result = await facebookRecipe.buildDiscoverUrlsAsync("macbook pro", {
      maxPrice: 0,
      fulfillment: "any",
      aiConfig: MOCK_AI_CONFIG,
    });
    expect(result.urls[0]).toContain("query=macbook+pro");
  });

  it("includes maxPrice when > 0", async () => {
    const result = await facebookRecipe.buildDiscoverUrlsAsync("laptop", {
      maxPrice: 500,
      fulfillment: "any",
      aiConfig: MOCK_AI_CONFIG,
    });
    expect(result.urls[0]).toContain("maxPrice=500");
  });

  it("injects region location segment when pickup fulfillment and matching region", async () => {
    const result = await facebookRecipe.buildDiscoverUrlsAsync("laptop", {
      maxPrice: 0,
      fulfillment: "pickup",
      regionValue: "2",
      aiConfig: MOCK_AI_CONFIG,
    });
    expect(result.urls[0]).toContain("/marketplace/auckland/search");
  });

  it("returns an empty warnings array", async () => {
    const result = await facebookRecipe.buildDiscoverUrlsAsync("macbook pro", {
      maxPrice: 0,
      fulfillment: "any",
      aiConfig: MOCK_AI_CONFIG,
    });
    expect(result.warnings).toEqual([]);
  });
});

describe("buildFacebookListing", () => {
  it("sets source to facebook", () => {
    const listing = buildFacebookListing(
      "https://facebook.com/marketplace/item/123",
      undefined,
      "Vintage lamp",
      80,
      "NZ$80",
      "Auckland",
    );
    expect(listing.source).toBe("facebook");
  });

  it("sets isAuction to false", () => {
    const listing = buildFacebookListing(
      "https://facebook.com/marketplace/item/123",
      undefined,
      "Lamp",
      null,
      "Price on request",
      "Wellington",
    );
    expect(listing.isAuction).toBe(false);
  });
});
