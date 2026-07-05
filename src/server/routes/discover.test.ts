import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiscoverableRecipe,
  DiscoverContext,
  RecipeDiscoverResult,
} from "../../lib/recipes/base";
import { discoverCategoriesAsync } from "./discover";

vi.mock("../recipes/registry", () => ({
  getAllRecipes: vi.fn(),
}));
vi.mock("../helpers", () => ({}));
vi.mock("../../lib/validate", () => ({}));
vi.mock("../ai", () => ({
  getAIConfig: vi.fn(),
}));

import { getAIConfig } from "../ai";
import { getAllRecipes } from "../recipes/registry";

function makeStubRecipe(urls: string[], warnings: string[] = []): DiscoverableRecipe {
  return {
    name: "stub",
    matches: () => false,
    extractImplicitFilters: () => [],
    quickSearchAsync: async () => {},
    deepSearchAsync: async () => {},
    buildDiscoverUrlsAsync: async () => ({ urls, warnings }),
  };
}

function withBuildDiscover(
  base: DiscoverableRecipe,
  buildDiscoverUrlsAsync: (
    prompt: string,
    context: DiscoverContext,
  ) => Promise<RecipeDiscoverResult>,
): DiscoverableRecipe {
  return { ...base, buildDiscoverUrlsAsync };
}

const MOCK_AI_CONFIG = { url: "http://example.com", model: "llama", apiKey: "key" };

describe("discoverCategoriesAsync", () => {
  beforeEach(() => {
    vi.mocked(getAIConfig).mockReturnValue(MOCK_AI_CONFIG);
  });

  afterEach(() => vi.clearAllMocks());

  it("does not return a filters field", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      makeStubRecipe(["https://www.trademe.co.nz/a/marketplace/computers/laptops/search"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 500, "any", undefined);
    expect(result).not.toHaveProperty("filters");
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

  it("passes the correct DiscoverContext to each recipe", async () => {
    const captured: { prompt: string; context: unknown }[] = [];
    vi.mocked(getAllRecipes).mockReturnValue([
      withBuildDiscover(makeStubRecipe(["https://www.trademe.co.nz/a/x"]), async (p, ctx) => {
        captured.push({ prompt: p, context: ctx });
        return { urls: ["https://www.trademe.co.nz/a/x"], warnings: [] };
      }),
    ]);

    await discoverCategoriesAsync("  macbook  ", 800, "pickup", "2");
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe("  macbook  ");
    expect(captured[0].context).toEqual({
      maxPrice: 800,
      fulfillment: "pickup",
      regionValue: "2",
      aiConfig: MOCK_AI_CONFIG,
    });
  });

  it("returns URLs from successful recipes even when another recipe throws", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      withBuildDiscover(makeStubRecipe([]), async () => {
        throw new Error("AI unavailable");
      }),
      makeStubRecipe(["https://www.facebook.com/marketplace/search?query=laptop"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain("facebook.com");
  });

  it("includes a warning for each recipe that throws", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      withBuildDiscover(makeStubRecipe([]), async () => {
        throw new Error("AI unavailable");
      }),
      makeStubRecipe(["https://www.facebook.com/marketplace/search?query=laptop"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("AI unavailable");
  });

  it("propagates warnings returned by a recipe", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      makeStubRecipe(
        ["https://www.trademe.co.nz/a/x"],
        ["step2:computers/computers unexpected result"],
      ),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.warnings).toContain("step2:computers/computers unexpected result");
  });

  it("returns an empty warnings array when all recipes succeed cleanly", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([makeStubRecipe(["https://www.trademe.co.nz/a/x"])]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.warnings).toEqual([]);
  });

  it("throws when all recipes fail", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      withBuildDiscover(makeStubRecipe([]), async () => {
        throw new Error("AI unavailable");
      }),
    ]);

    await expect(discoverCategoriesAsync("laptop", 0, "any", undefined)).rejects.toThrow(
      "No URLs returned from any recipe",
    );
  });

  it("strips bearer tokens from warning messages", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      withBuildDiscover(makeStubRecipe([]), async () => {
        throw new Error("Unauthorized: bearer abc123xyz");
      }),
      makeStubRecipe(["https://www.trademe.co.nz/a/x"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain("abc123xyz");
    expect(result.warnings[0]).toContain("[redacted]");
  });

  it("strips API keys from warning messages", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      withBuildDiscover(makeStubRecipe([]), async () => {
        throw new Error("Invalid api-key=sk-secretvalue123 provided");
      }),
      makeStubRecipe(["https://www.trademe.co.nz/a/x"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain("sk-secretvalue123");
    expect(result.warnings[0]).toContain("[redacted]");
  });

  it("strips sk- prefixed tokens from warning messages", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      withBuildDiscover(makeStubRecipe([]), async () => {
        throw new Error("Authentication failed with token sk-abcDEF123456");
      }),
      makeStubRecipe(["https://www.trademe.co.nz/a/x"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain("sk-abcDEF123456");
    expect(result.warnings[0]).toContain("[redacted]");
  });

  it("prefixes rejection warning with the recipe name", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      withBuildDiscover({ ...makeStubRecipe([]), name: "trademe" }, async () => {
        throw new Error("AI unavailable");
      }),
      makeStubRecipe(["https://www.facebook.com/marketplace/search?query=laptop"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toBe("trademe: AI unavailable");
  });

  it("uses 'Recipe failed' for non-Error rejections", async () => {
    vi.mocked(getAllRecipes).mockReturnValue([
      withBuildDiscover(makeStubRecipe([]), async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "some string rejection with api_key=secret";
      }),
      makeStubRecipe(["https://www.trademe.co.nz/a/x"]),
    ]);

    const result = await discoverCategoriesAsync("laptop", 0, "any", undefined);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toBe("stub: Recipe failed");
  });

  it("throws before calling any recipe when AI config is misconfigured", async () => {
    vi.mocked(getAIConfig).mockImplementation(() => {
      throw new Error("GROQ_API_KEY is not set");
    });
    const buildSpy = vi.fn().mockResolvedValue({ urls: ["https://example.com"], warnings: [] });
    vi.mocked(getAllRecipes).mockReturnValue([withBuildDiscover(makeStubRecipe([]), buildSpy)]);

    await expect(discoverCategoriesAsync("laptop", 0, "any", undefined)).rejects.toThrow(
      "GROQ_API_KEY is not set",
    );
    expect(buildSpy).not.toHaveBeenCalled();
  });
});
