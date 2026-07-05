import { describe, expect, it } from "vitest";
import { isValidRecipeUrl, recipeIdForUrl } from "./matcher";
import { RecipeId } from "./metadata";

describe("isValidRecipeUrl", () => {
  describe("trademe", () => {
    it("accepts a trademe root URL", () => {
      expect(isValidRecipeUrl("https://www.trademe.co.nz/")).toBe(true);
    });

    it("accepts a trademe listing URL with any path", () => {
      expect(isValidRecipeUrl("https://www.trademe.co.nz/a/marketplace/listing/123")).toBe(true);
    });
  });

  describe("facebook marketplace", () => {
    it("accepts a facebook marketplace item URL", () => {
      expect(isValidRecipeUrl("https://www.facebook.com/marketplace/item/123")).toBe(true);
    });

    it("rejects a facebook URL without /marketplace/ path", () => {
      expect(isValidRecipeUrl("https://www.facebook.com/groups/456")).toBe(false);
    });
  });

  describe("unrecognised hostnames", () => {
    it("rejects a URL with wrong hostname even if path matches", () => {
      expect(isValidRecipeUrl("https://www.notfacebook.com/marketplace/item/123")).toBe(false);
    });

    it("rejects a completely unrelated URL", () => {
      expect(isValidRecipeUrl("https://www.google.com/search?q=test")).toBe(false);
    });
  });

  describe("malformed input", () => {
    it("rejects an empty string", () => {
      expect(isValidRecipeUrl("")).toBe(false);
    });

    it("rejects a plain string that is not a URL", () => {
      expect(isValidRecipeUrl("not-a-url")).toBe(false);
    });
  });
});

describe("recipeIdForUrl", () => {
  it("resolves a trademe URL to the Trademe recipe id", () => {
    expect(recipeIdForUrl("https://www.trademe.co.nz/a/marketplace/listing/123")).toBe(
      RecipeId.Trademe,
    );
  });

  it("resolves a facebook marketplace URL to the Facebook recipe id", () => {
    expect(recipeIdForUrl("https://www.facebook.com/marketplace/item/123")).toBe(RecipeId.Facebook);
  });

  it("returns null for an unrecognised URL", () => {
    expect(recipeIdForUrl("https://www.google.com/search?q=test")).toBe(null);
  });

  it("returns null for malformed input", () => {
    expect(recipeIdForUrl("not-a-url")).toBe(null);
  });
});

describe("RecipeId", () => {
  it("assigns Trademe recipe id 1", () => {
    expect(RecipeId.Trademe).toBe(1);
  });

  it("assigns Facebook recipe id 2", () => {
    expect(RecipeId.Facebook).toBe(2);
  });
});
