import { AI_FILTER_SYSTEM_MESSAGE } from "../../../src/server/routes/aiFilter";
import type { PromptTestCase, PromptTestSuite } from "../types";

// ── Assertion helpers ─────────────────────────────────────────────────────────

type FilterResult = { index: number; pass: boolean; reason: string | null };

function parseResults(output: unknown): FilterResult[] {
  if (typeof output !== "object" || output === null) throw new Error("Expected an object");
  const obj = output as Record<string, unknown>;
  if (!Array.isArray(obj.results)) throw new Error(`Expected results array, got ${JSON.stringify(obj)}`);
  return obj.results as FilterResult[];
}

function assertPasses(results: FilterResult[], index: number): void {
  const found = results.find((r) => r.index === index);
  if (!found?.pass) throw new Error(`Expected listing ${index} to pass, got: ${JSON.stringify(found)}`);
}

function assertFails(results: FilterResult[], index: number): void {
  const found = results.find((r) => r.index === index);
  if (found === undefined) throw new Error(`Listing ${index} not found in results`);
  if (found.pass) throw new Error(`Expected listing ${index} to fail, but it passed`);
}

// ── Validators ────────────────────────────────────────────────────────────────

export function validateLaptopFilterOutput(output: unknown): void {
  const results = parseResults(output);
  assertPasses(results, 1); // MacBook Pro — must pass
  assertFails(results, 4);  // Grey couch — must fail
}

export function validateCouchFilterOutput(output: unknown): void {
  const results = parseResults(output);
  assertPasses(results, 1); // Couch — must pass
  assertPasses(results, 2); // Sofa — must pass (same item type, different word)
  assertFails(results, 3);  // Dining table — must fail
}

export function validateWrongCarsFilterOutput(output: unknown): void {
  const results = parseResults(output);
  if (results.length === 0) throw new Error("Expected at least one result");
  for (const result of results) {
    if (result.pass) {
      throw new Error(`Expected all wrong-brand car listings to fail, but listing ${result.index} passed`);
    }
  }
}

// ── Case builder ──────────────────────────────────────────────────────────────

type FilterListing = {
  title: string;
  price: string;
  location: string;
  description: string;
};

function buildUserMessage(criteria: string, listings: FilterListing[]): string {
  const numbered = listings
    .map(
      (listing, i) =>
        `${i + 1}. Title: "${listing.title}" | Price: ${listing.price} | Location: ${listing.location}${listing.description ? ` | Description: ${listing.description}` : ""}`,
    )
    .join("\n");
  return `Criteria: ${criteria}\n\nListings:\n${numbered}`;
}

function defineFilterCase(opts: {
  id: string;
  label: string;
  criteria: string;
  listings: FilterListing[];
  validate(output: unknown): void;
}): PromptTestCase {
  return {
    id: opts.id,
    label: opts.label,
    systemMessage: AI_FILTER_SYSTEM_MESSAGE,
    userMessage: buildUserMessage(opts.criteria, opts.listings),
    maxTokens: 512,
    validate: opts.validate,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

export const aiFilterSuite: PromptTestSuite = {
  name: "AI Filter",
  cases: [
    defineFilterCase({
      id: "aiFilter-laptop",
      label: "MacBook Pro 13 M1 — relevant vs irrelevant listings",
      criteria: "MacBook Pro 13 M1",
      listings: [
        {
          title: "Apple MacBook Pro 13 M1 8GB 256GB Space Grey",
          price: "$1,200",
          location: "Auckland",
          description: "Excellent condition, barely used",
        },
        {
          title: "MacBook Air M1 8GB 256GB Gold",
          price: "$950",
          location: "Wellington",
          description: "Good condition",
        },
        {
          title: "Apple iPad Pro 11 inch M2",
          price: "$800",
          location: "Christchurch",
          description: "",
        },
        {
          title: "Grey corner couch 3-seater",
          price: "$300",
          location: "Auckland",
          description: "Good condition, pickup only",
        },
      ],
      validate: validateLaptopFilterOutput,
    }),

    defineFilterCase({
      id: "aiFilter-couch",
      label: "Second hand couch — couches pass, table fails",
      criteria: "second hand couch",
      listings: [
        {
          title: "3-seater grey fabric couch",
          price: "$350",
          location: "Auckland",
          description: "Great condition, pet free home",
        },
        {
          title: "L-shaped corner sofa dark blue",
          price: "$500",
          location: "Wellington",
          description: "Excellent condition",
        },
        {
          title: "Solid oak dining table 6 seater",
          price: "$280",
          location: "Christchurch",
          description: "Barely used",
        },
        {
          title: "Outdoor wicker armchair",
          price: "$120",
          location: "Hamilton",
          description: "Weather resistant",
        },
      ],
      validate: validateCouchFilterOutput,
    }),

    defineFilterCase({
      id: "aiFilter-wrong-cars",
      label: "BMW 3 series — wrong-brand car listings all fail",
      criteria: "BMW 3 series 2019",
      listings: [
        {
          title: "Honda Civic 2019 hatchback 1.5T",
          price: "$18,000",
          location: "Auckland",
          description: "Low kms, one owner",
        },
        {
          title: "Toyota Corolla 2018 sedan",
          price: "$16,500",
          location: "Wellington",
          description: "Full service history",
        },
        {
          title: "Volkswagen Golf GTI 2020",
          price: "$24,000",
          location: "Christchurch",
          description: "Excellent condition",
        },
        {
          title: "Mazda 3 2019 hatchback",
          price: "$19,000",
          location: "Hamilton",
          description: "One careful owner",
        },
        {
          title: "Hyundai i30 2019 wagon",
          price: "$15,000",
          location: "Dunedin",
          description: "Great family car",
        },
      ],
      validate: validateWrongCarsFilterOutput,
    }),
  ],
};
