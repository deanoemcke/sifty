import { describe, it, expect } from "vitest";
import {
  validateLaptopFilterOutput,
  validateCouchFilterOutput,
  validateWrongCarsFilterOutput,
} from "./aiFilterSuite";

type FilterResult = { index: number; pass: boolean; reason: string | null };

function makeOutput(results: FilterResult[]): unknown {
  return { results };
}

describe("validateLaptopFilterOutput", () => {
  it("passes when MacBook Pro (1) passes and couch (4) fails", () => {
    const output = makeOutput([
      { index: 1, pass: true, reason: null },
      { index: 2, pass: true, reason: null },
      { index: 3, pass: false, reason: "tablet" },
      { index: 4, pass: false, reason: "furniture" },
    ]);
    expect(() => validateLaptopFilterOutput(output)).not.toThrow();
  });

  it("throws when the MacBook Pro listing is rejected", () => {
    const output = makeOutput([
      { index: 1, pass: false, reason: "not relevant" },
      { index: 4, pass: false, reason: "furniture" },
    ]);
    expect(() => validateLaptopFilterOutput(output)).toThrow();
  });

  it("throws when the couch listing is passed", () => {
    const output = makeOutput([
      { index: 1, pass: true, reason: null },
      { index: 4, pass: true, reason: null },
    ]);
    expect(() => validateLaptopFilterOutput(output)).toThrow();
  });

  it("throws when output has no results array", () => {
    expect(() => validateLaptopFilterOutput({ data: [] })).toThrow();
    expect(() => validateLaptopFilterOutput(null)).toThrow();
    expect(() => validateLaptopFilterOutput("string")).toThrow();
  });
});

describe("validateCouchFilterOutput", () => {
  it("passes when couch (1) and sofa (2) pass, dining table (3) fails", () => {
    const output = makeOutput([
      { index: 1, pass: true, reason: null },
      { index: 2, pass: true, reason: null },
      { index: 3, pass: false, reason: "not a couch" },
      { index: 4, pass: true, reason: null },
    ]);
    expect(() => validateCouchFilterOutput(output)).not.toThrow();
  });

  it("throws when the couch listing is rejected", () => {
    const output = makeOutput([
      { index: 1, pass: false, reason: "not relevant" },
      { index: 2, pass: true, reason: null },
    ]);
    expect(() => validateCouchFilterOutput(output)).toThrow();
  });

  it("throws when the sofa listing is rejected", () => {
    const output = makeOutput([
      { index: 1, pass: true, reason: null },
      { index: 2, pass: false, reason: "not relevant" },
    ]);
    expect(() => validateCouchFilterOutput(output)).toThrow();
  });

  it("throws when the dining table is passed", () => {
    const output = makeOutput([
      { index: 1, pass: true, reason: null },
      { index: 2, pass: true, reason: null },
      { index: 3, pass: true, reason: null },
    ]);
    expect(() => validateCouchFilterOutput(output)).toThrow();
  });
});

describe("validateWrongCarsFilterOutput", () => {
  it("passes when all 5 wrong-brand car listings fail", () => {
    const output = makeOutput([
      { index: 1, pass: false, reason: "Honda not BMW" },
      { index: 2, pass: false, reason: "Toyota not BMW" },
      { index: 3, pass: false, reason: "Volkswagen not BMW" },
      { index: 4, pass: false, reason: "Mazda not BMW" },
      { index: 5, pass: false, reason: "Hyundai not BMW" },
    ]);
    expect(() => validateWrongCarsFilterOutput(output)).not.toThrow();
  });

  it("throws when any wrong-brand listing passes", () => {
    const output = makeOutput([
      { index: 1, pass: false, reason: "wrong brand" },
      { index: 2, pass: true, reason: null },
    ]);
    expect(() => validateWrongCarsFilterOutput(output)).toThrow();
  });

  it("throws when results is empty", () => {
    expect(() => validateWrongCarsFilterOutput({ results: [] })).toThrow();
  });
});
