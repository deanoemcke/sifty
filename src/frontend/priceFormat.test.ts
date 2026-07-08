import { describe, expect, it } from "vitest";
import { formatListingPrice } from "./priceFormat";

describe("formatListingPrice", () => {
  it("returns 'Price on request' for null", () => {
    expect(formatListingPrice(null)).toBe("Price on request");
  });

  it("returns 'Free' for zero", () => {
    expect(formatListingPrice(0)).toBe("Free");
  });

  it("formats a simple number with $ prefix", () => {
    expect(formatListingPrice(100)).toBe("$100");
  });

  it("adds thousands separators to large numbers", () => {
    expect(formatListingPrice(1500)).toBe("$1,500");
  });

  it("rounds to the nearest whole dollar", () => {
    expect(formatListingPrice(1500.5)).toBe("$1,501");
    expect(formatListingPrice(1500.49)).toBe("$1,500");
  });

  it("handles very large numbers with multiple separators", () => {
    expect(formatListingPrice(1234567)).toBe("$1,234,567");
  });
});
