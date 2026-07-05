import { describe, expect, it } from "vitest";
import { RecipeId } from "../lib/recipes/metadata";
import { recipeFaviconHtml, sourceFaviconHtml } from "./recipeDisplay";

describe("recipeFaviconHtml", () => {
  it("renders the trademe favicon for the Trademe recipe id", () => {
    const html = recipeFaviconHtml(RecipeId.Trademe);
    expect(html).toContain("<img");
    expect(html).toContain("trademe.co.nz");
    expect(html).toContain("Trade Me");
  });

  it("renders the facebook favicon for the Facebook recipe id", () => {
    const html = recipeFaviconHtml(RecipeId.Facebook);
    expect(html).toContain("facebook.com");
    expect(html).toContain("Facebook");
  });
});

describe("sourceFaviconHtml", () => {
  it("returns an img tag for trademe with correct favicon URL and label", () => {
    const html = sourceFaviconHtml("trademe");
    expect(html).toContain("<img");
    expect(html).toContain("trademe.co.nz");
    expect(html).toContain("Trade Me");
  });

  it("returns an img tag for facebook with correct favicon URL and label", () => {
    const html = sourceFaviconHtml("facebook");
    expect(html).toContain("<img");
    expect(html).toContain("facebook.com");
    expect(html).toContain("Facebook");
  });

  it("includes class, width, height attributes", () => {
    const html = sourceFaviconHtml("trademe");
    expect(html).toContain('class="source-favicon"');
    expect(html).toContain('width="14"');
    expect(html).toContain('height="14"');
  });

  it("renders at the requested size, fetching a higher-resolution source", () => {
    const html = sourceFaviconHtml("trademe", 28);
    expect(html).toContain('width="28"');
    expect(html).toContain('height="28"');
    expect(html).toContain("sz=64");
  });

  it("fetches the small source image at the default size", () => {
    const html = sourceFaviconHtml("trademe");
    expect(html).toContain("sz=16");
  });
});
