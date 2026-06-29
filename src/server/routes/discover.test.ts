import { describe, expect, it, vi } from "vitest";
import { discoverCategoriesAsync } from "./discover";

vi.mock("../../lib/recipes/server", () => ({
  getAllRecipes: vi.fn(),
}));
vi.mock("../helpers", () => ({}));
vi.mock("../../lib/validate", () => ({}));

import { getAllRecipes } from "../../lib/recipes/server";

function makeStubRecipe(urls: string[]) {
  return {
    name: "stub",
    matches: () => false,
    extractImplicitFilters: () => [],
    quickSearchAsync: async () => {},
    deepSearchAsync: async () => {},
    buildDiscoverUrlsAsync: async () => urls,
  };
}

describe("discoverCategoriesAsync", () => {
  it("returns filters without a minPrice field", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      makeStubRecipe(["https://www.trademe.co.nz/a/marketplace/computers/laptops/search"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 500, "any", undefined);
    expect(result.filters).not.toHaveProperty("minPrice");
  });

  it("aggregates URLs from all recipes", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      makeStubRecipe(["https://www.trademe.co.nz/a/marketplace/computers/search"]),
      makeStubRecipe(["https://www.facebook.com/marketplace/search?query=laptop"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.urls).toHaveLength(2);
    expect(result.urls.some((u) => u.includes("trademe"))).toBe(true);
    expect(result.urls.some((u) => u.includes("facebook"))).toBe(true);
  });

  it("throws when no recipes return any URLs", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([makeStubRecipe([])]);

    await expect(discoverCategoriesAsync("laptop", 0, "any", undefined)).rejects.toThrow(
      "No URLs returned from any recipe",
    );
  });

  it("sets name to the trimmed prompt", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      makeStubRecipe(["https://www.trademe.co.nz/a/marketplace/computers/laptops/search"]),
    ]);

    const result = await discoverCategoriesAsync("  macbook pro  ", 0, "any", undefined);
    expect(result.name).toBe("macbook pro");
  });

  it("sets shippingAvailable=false when fulfillment is pickup with a region", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([makeStubRecipe(["https://www.trademe.co.nz/a/x"])]);

    const result = await discoverCategoriesAsync("laptop", 0, "pickup", "2");
    expect(result.filters.shippingAvailable).toBe(false);
    expect(result.filters.pickupAvailable).toBe(true);
  });

  it("sets shippingAvailable=true when fulfillment is any", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([makeStubRecipe(["https://www.trademe.co.nz/a/x"])]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.filters.shippingAvailable).toBe(true);
  });

  it("passes maxPrice from context through to filters", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([makeStubRecipe(["https://www.trademe.co.nz/a/x"])]);

    const result = await discoverCategoriesAsync("laptop", 750, "any", undefined);
    expect(result.filters.maxPrice).toBe(750);
  });

  it("sets pickupAvailable=false when fulfillment is shipping", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([makeStubRecipe(["https://www.trademe.co.nz/a/x"])]);

    const result = await discoverCategoriesAsync("laptop", 0, "shipping", undefined);
    expect(result.filters.pickupAvailable).toBe(false);
    expect(result.filters.shippingAvailable).toBe(true);
  });

  it("sets shippingAvailable=false when fulfillment is pickup even without a region", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([makeStubRecipe(["https://www.trademe.co.nz/a/x"])]);

    const result = await discoverCategoriesAsync("laptop", 0, "pickup", undefined);
    expect(result.filters.shippingAvailable).toBe(false);
  });

  it("passes the correct DiscoverContext to each recipe", async () => {
    const captured: { prompt: string; context: unknown }[] = [];
    vi.mocked(getAllRecipes).mockReturnValue([
      {
        ...makeStubRecipe(["https://www.trademe.co.nz/a/x"]),
        buildDiscoverUrlsAsync: async (p, ctx) => {
          captured.push({ prompt: p, context: ctx });
          return ["https://www.trademe.co.nz/a/x"];
        },
      },
    ]);

    await discoverCategoriesAsync("  macbook  ", 800, "pickup", "2");
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe("  macbook  ");
    expect(captured[0].context).toEqual({ maxPrice: 800, fulfillment: "pickup", regionValue: "2" });
  });

  it("returns URLs from successful recipes even when another recipe throws", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      {
        ...makeStubRecipe([]),
        buildDiscoverUrlsAsync: async () => {
          throw new Error("AI unavailable");
        },
      },
      makeStubRecipe(["https://www.facebook.com/marketplace/search?query=laptop"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain("facebook.com");
  });

  it("throws when all recipes fail", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      {
        ...makeStubRecipe([]),
        buildDiscoverUrlsAsync: async () => {
          throw new Error("AI unavailable");
        },
      },
    ]);

    await expect(discoverCategoriesAsync("laptop", 0, "any", undefined)).rejects.toThrow(
      "No URLs returned from any recipe",
    );
  });
});
