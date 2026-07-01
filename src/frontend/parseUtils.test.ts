import { describe, expect, it } from "vitest";
import { parseMaxPrice } from "./parseUtils";

describe("parseMaxPrice", () => {
  it("returns the numeric value for a valid positive price", () => {
    expect(parseMaxPrice("49.99")).toBe(49.99);
  });

  it("returns undefined for an empty string", () => {
    expect(parseMaxPrice("")).toBeUndefined();
  });

  it("returns undefined for non-numeric input", () => {
    expect(parseMaxPrice("abc")).toBeUndefined();
  });

  it("returns undefined for Infinity (e.g. 1e999)", () => {
    expect(parseMaxPrice("1e999")).toBeUndefined();
  });

  it("returns undefined for zero", () => {
    expect(parseMaxPrice("0")).toBeUndefined();
  });

  it("returns undefined for a negative value", () => {
    expect(parseMaxPrice("-10")).toBeUndefined();
  });

  it("trims whitespace before parsing", () => {
    expect(parseMaxPrice("  25  ")).toBe(25);
  });
});
