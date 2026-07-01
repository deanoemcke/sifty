import { describe, it, expect } from "vitest";
import {
  validateStep1MacbookOutput,
  validateStep1BmwOutput,
  validateStep1CouchOutput,
  validateStep2ComputersLaptopsMacbookOutput,
  validateStep2MotorsCarsBmwOutput,
} from "./trademeDiscoverSuite";

// ── Step 1 validators ────────────────────────────────────────────────────────

describe("validateStep1MacbookOutput", () => {
  it("passes when a computers category is picked and searchQuery has no specs", () => {
    const output = {
      categories: ["Computers > Laptops"],
      searchLabel: "MacBook Pro laptops",
      searchQuery: "macbook pro",
    };
    expect(() => validateStep1MacbookOutput(output)).not.toThrow();
  });

  it("also accepts null searchQuery (category name is descriptive enough)", () => {
    const output = {
      categories: ["Computers > Laptops"],
      searchLabel: "MacBook Pro",
      searchQuery: null,
    };
    expect(() => validateStep1MacbookOutput(output)).not.toThrow();
  });

  it("throws when no computers-related category is returned", () => {
    const output = {
      categories: ["Home & living > Lounge, dining & hall"],
      searchLabel: "MacBook Pro",
      searchQuery: "macbook pro",
    };
    expect(() => validateStep1MacbookOutput(output)).toThrow();
  });

  it("throws when searchQuery contains spec words", () => {
    const specOutputs = [
      { categories: ["Computers > Laptops"], searchLabel: "MacBook", searchQuery: "macbook pro m1" },
      { categories: ["Computers > Laptops"], searchLabel: "MacBook", searchQuery: "macbook pro 16gb" },
      { categories: ["Computers > Laptops"], searchLabel: "MacBook", searchQuery: "macbook pro 2021" },
      { categories: ["Computers > Laptops"], searchLabel: "MacBook", searchQuery: "macbook pro 256gb" },
    ];
    for (const output of specOutputs) {
      expect(() => validateStep1MacbookOutput(output)).toThrow();
    }
  });

  it("throws when output lacks required fields", () => {
    expect(() => validateStep1MacbookOutput(null)).toThrow();
    expect(() => validateStep1MacbookOutput({})).toThrow();
    expect(() => validateStep1MacbookOutput({ categories: "not-an-array" })).toThrow();
  });
});

describe("validateStep1BmwOutput", () => {
  it("passes when a motors/cars category is picked", () => {
    const output = {
      categories: ["Trade Me Motors > Cars"],
      searchLabel: "BMW 3 series",
      searchQuery: "bmw 3 series",
    };
    expect(() => validateStep1BmwOutput(output)).not.toThrow();
  });

  it("also accepts null searchQuery", () => {
    const output = { categories: ["Trade Me Motors > Cars"], searchLabel: "BMW 3 series", searchQuery: null };
    expect(() => validateStep1BmwOutput(output)).not.toThrow();
  });

  it("throws when searchQuery contains the year", () => {
    const output = {
      categories: ["Trade Me Motors > Cars"],
      searchLabel: "BMW 3 series",
      searchQuery: "bmw 3 series 2019",
    };
    expect(() => validateStep1BmwOutput(output)).toThrow();
  });

  it("throws when no motors category is returned", () => {
    const output = {
      categories: ["Computers > Laptops"],
      searchLabel: "BMW 3 series",
      searchQuery: "bmw 3 series",
    };
    expect(() => validateStep1BmwOutput(output)).toThrow();
  });
});

describe("validateStep1CouchOutput", () => {
  it("passes when a home/living or furniture category is picked", () => {
    const output = {
      categories: ["Home & living > Lounge, dining & hall"],
      searchLabel: "corner couch",
      searchQuery: "couch",
    };
    expect(() => validateStep1CouchOutput(output)).not.toThrow();
  });

  it("also accepts null searchQuery", () => {
    const output = {
      categories: ["Home & living > Lounge, dining & hall"],
      searchLabel: "corner couch",
      searchQuery: null,
    };
    expect(() => validateStep1CouchOutput(output)).not.toThrow();
  });

  it("throws when a motors or computers category is returned instead", () => {
    const output = {
      categories: ["Computers > Laptops"],
      searchLabel: "couch",
      searchQuery: "couch",
    };
    expect(() => validateStep1CouchOutput(output)).toThrow();
  });
});

// ── Step 2 validators ────────────────────────────────────────────────────────

describe("validateStep2ComputersLaptopsMacbookOutput", () => {
  it("passes when a laptop/apple slug is selected with correct searchString", () => {
    const output = {
      categories: [{ slug: "computers/laptops/laptops/apple", searchString: "macbook pro" }],
    };
    expect(() => validateStep2ComputersLaptopsMacbookOutput(output)).not.toThrow();
  });

  it("also accepts a broader laptops slug", () => {
    const output = {
      categories: [{ slug: "computers/laptops/laptops", searchString: "macbook pro" }],
    };
    expect(() => validateStep2ComputersLaptopsMacbookOutput(output)).not.toThrow();
  });

  it("throws when no laptop-related slug is returned", () => {
    const output = {
      categories: [{ slug: "computers/laptops/batteries", searchString: "macbook pro" }],
    };
    expect(() => validateStep2ComputersLaptopsMacbookOutput(output)).toThrow();
  });

  it("throws when searchString contains specs", () => {
    const output = {
      categories: [{ slug: "computers/laptops/laptops/apple", searchString: "macbook pro m1 16gb" }],
    };
    expect(() => validateStep2ComputersLaptopsMacbookOutput(output)).toThrow();
  });

  it("throws when output lacks categories array", () => {
    expect(() => validateStep2ComputersLaptopsMacbookOutput(null)).toThrow();
    expect(() => validateStep2ComputersLaptopsMacbookOutput({})).toThrow();
  });
});

describe("validateStep2MotorsCarsBmwOutput", () => {
  it("passes when a BMW or cars slug is selected", () => {
    const output = {
      categories: [{ slug: "motors/cars/bmw", searchString: null }],
    };
    expect(() => validateStep2MotorsCarsBmwOutput(output)).not.toThrow();
  });

  it("also accepts a broader cars slug with a searchString", () => {
    const output = {
      categories: [{ slug: "motors/cars", searchString: "bmw 3 series" }],
    };
    expect(() => validateStep2MotorsCarsBmwOutput(output)).not.toThrow();
  });

  it("throws when searchString contains a year", () => {
    const output = {
      categories: [{ slug: "motors/cars/bmw", searchString: "bmw 2019" }],
    };
    expect(() => validateStep2MotorsCarsBmwOutput(output)).toThrow();
  });

  it("throws when a non-cars slug is returned", () => {
    const output = {
      categories: [{ slug: "motors/motorbikes", searchString: null }],
    };
    expect(() => validateStep2MotorsCarsBmwOutput(output)).toThrow();
  });
});
