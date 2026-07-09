import { describe, expect, it } from "vitest";
import type { Listing } from "../../lib/recipes/base";
import { normalizeCachedListings } from "./quickSearch";

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "trademe",
    title: "test",
    price: 10,
    location: "",
    url: "https://example.com/1",
    isAuction: false,
    relevance: 0,
    ...overrides,
  };
}

describe("normalizeCachedListings", () => {
  it("leaves a listing with an existing relevance untouched", () => {
    const listing = makeListing({ relevance: 7 });
    expect(normalizeCachedListings([listing])).toEqual([listing]);
  });

  it("defaults relevance to 0 for a pre-deploy cached row missing the field", () => {
    // Simulates a row cached before `relevance` became mandatory on `Listing` —
    // the field is simply absent, which the `as Listing[]` cast on
    // `JSON.parse` lets through the type system undetected.
    const staleRow = [makeListing()];
    delete (staleRow[0] as Partial<Listing>).relevance;
    expect(staleRow[0].relevance).toBeUndefined();

    const normalized = normalizeCachedListings(staleRow as Listing[]);
    expect(normalized[0].relevance).toBe(0);
  });

  it("does not mutate the input array", () => {
    const staleRow = [makeListing()];
    delete (staleRow[0] as Partial<Listing>).relevance;
    const original = JSON.parse(JSON.stringify(staleRow));
    normalizeCachedListings(staleRow as Listing[]);
    expect(staleRow).toEqual(original);
  });
});
