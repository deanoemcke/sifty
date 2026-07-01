import type Database from "better-sqlite3";
import { stmtGetCategoriesAtDepth2, stmtGetCategoriesByTop2, type CategoryRow } from "../../../src/server/db";
import { STEP1_SYSTEM_PROMPT, STEP2_SYSTEM_PROMPT } from "../../../src/server/recipes/trademe";
import type { PromptTestCase, PromptTestSuite } from "../types";

// ── Assertion helpers ─────────────────────────────────────────────────────────

const SPEC_PATTERN = /\b(m1|m2|m3|m4|pro max|\d+gb|\d+tb|\d{4})\b/i;

function assertNoSpecs(value: string | null, field: string): void {
  if (value !== null && SPEC_PATTERN.test(value)) {
    throw new Error(`${field} contains spec words: "${value}"`);
  }
}

function getCategories(output: unknown): Array<unknown> {
  if (typeof output !== "object" || output === null) throw new Error("Expected an object");
  const obj = output as Record<string, unknown>;
  if (!Array.isArray(obj.categories)) throw new Error(`Expected categories array, got ${JSON.stringify(obj)}`);
  return obj.categories;
}

// ── Step 1 validators ─────────────────────────────────────────────────────────

export function validateStep1MacbookOutput(output: unknown): void {
  const categories = getCategories(output) as string[];
  const hasComputers = categories.some((c) => /computer/i.test(c));
  if (!hasComputers) throw new Error(`Expected a computers category, got: ${JSON.stringify(categories)}`);

  const obj = output as Record<string, unknown>;
  const searchQuery = obj.searchQuery as string | null;
  assertNoSpecs(searchQuery, "searchQuery");
}

export function validateStep1BmwOutput(output: unknown): void {
  const categories = getCategories(output) as string[];
  const hasMotors = categories.some((c) => /motor|car/i.test(c));
  if (!hasMotors) throw new Error(`Expected a motors/cars category, got: ${JSON.stringify(categories)}`);

  const obj = output as Record<string, unknown>;
  const searchQuery = obj.searchQuery as string | null;
  if (searchQuery !== null && /\b\d{4}\b/.test(searchQuery)) {
    throw new Error(`searchQuery should not contain a year: "${searchQuery}"`);
  }
}

export function validateStep1CouchOutput(output: unknown): void {
  const categories = getCategories(output) as string[];
  const hasHomeOrFurniture = categories.some((c) => /home|living|lounge|furniture|sofa|couch/i.test(c));
  if (!hasHomeOrFurniture) {
    throw new Error(`Expected a home/furniture category, got: ${JSON.stringify(categories)}`);
  }
}

// ── Step 2 validators ─────────────────────────────────────────────────────────

type Step2Category = { slug: string; searchString: string | null };

function getStep2Categories(output: unknown): Step2Category[] {
  if (typeof output !== "object" || output === null) throw new Error("Expected an object");
  const obj = output as Record<string, unknown>;
  if (!Array.isArray(obj.categories)) throw new Error(`Expected categories array, got ${JSON.stringify(obj)}`);
  return obj.categories as Step2Category[];
}

export function validateStep2ComputersLaptopsMacbookOutput(output: unknown): void {
  const categories = getStep2Categories(output);
  const laptopEntry = categories.find((c) => /laptops\/laptops/.test(c.slug));
  if (!laptopEntry) {
    throw new Error(
      `Expected a slug containing "laptops/laptops", got: ${categories.map((c) => c.slug).join(", ")}`,
    );
  }
  assertNoSpecs(laptopEntry.searchString ?? null, "searchString");
}

export function validateStep2MotorsCarsBmwOutput(output: unknown): void {
  const categories = getStep2Categories(output);
  const carsEntry = categories.find((c) => /motors\/cars/.test(c.slug));
  if (!carsEntry) {
    throw new Error(
      `Expected a slug containing "motors/cars", got: ${categories.map((c) => c.slug).join(", ")}`,
    );
  }
  if (carsEntry.searchString !== null && /\b\d{4}\b/.test(carsEntry.searchString)) {
    throw new Error(`searchString should not contain a year: "${carsEntry.searchString}"`);
  }
}

// ── Case builders ─────────────────────────────────────────────────────────────

function buildStep1UserMessage(prompt: string, broad: CategoryRow[]): string {
  const list = broad.map((c) => c.display).join("\n");
  return `I'm looking for: ${prompt}\n\nAvailable categories:\n${list}`;
}

function buildStep2UserMessage(prompt: string, broadDisplay: string, candidates: CategoryRow[]): string {
  const list = candidates.map((c) => `${c.display} (slug: ${c.slug})`).join("\n");
  return `I'm looking for: ${prompt}\n\nCategories within "${broadDisplay}":\n${list}`;
}

// ── Suite factory ─────────────────────────────────────────────────────────────

export async function buildTrademeDiscoverSuiteAsync(db: Database.Database): Promise<PromptTestSuite> {
  const broad = stmtGetCategoriesAtDepth2(db).all();

  const computersLaptopsCandidates = stmtGetCategoriesByTop2(db).all("computers/laptops");
  const motorsCandidates = stmtGetCategoriesByTop2(db).all("motors/cars");

  const computersDisplay = broad.find((c) => c.slug === "computers/laptops")?.display ?? "Computers > Laptops";
  const motorsDisplay = broad.find((c) => c.slug === "motors/cars")?.display ?? "Trade Me Motors > Cars";

  const cases: PromptTestCase[] = [
    {
      id: "trademeStep1-macbook",
      label: "TradeMe step 1 — MacBook Pro 13 M1 broad category",
      systemMessage: STEP1_SYSTEM_PROMPT,
      userMessage: buildStep1UserMessage("Apple MacBook Pro 13 M1", broad),
      maxTokens: 512,
      validate: validateStep1MacbookOutput,
    },
    {
      id: "trademeStep1-bmw",
      label: "TradeMe step 1 — BMW 3 series 2019 broad category",
      systemMessage: STEP1_SYSTEM_PROMPT,
      userMessage: buildStep1UserMessage("BMW 3 series 2019", broad),
      maxTokens: 512,
      validate: validateStep1BmwOutput,
    },
    {
      id: "trademeStep1-couch",
      label: "TradeMe step 1 — grey corner couch broad category",
      systemMessage: STEP1_SYSTEM_PROMPT,
      userMessage: buildStep1UserMessage("grey corner couch", broad),
      maxTokens: 512,
      validate: validateStep1CouchOutput,
    },
    {
      id: "trademeStep2-computers-laptops-macbook",
      label: "TradeMe step 2 — MacBook Pro subcategory within Computers > Laptops",
      systemMessage: STEP2_SYSTEM_PROMPT,
      userMessage: buildStep2UserMessage("Apple MacBook Pro 13 M1", computersDisplay, computersLaptopsCandidates),
      maxTokens: 1024,
      validate: validateStep2ComputersLaptopsMacbookOutput,
    },
    {
      id: "trademeStep2-motors-cars-bmw",
      label: "TradeMe step 2 — BMW 3 series subcategory within Motors > Cars",
      systemMessage: STEP2_SYSTEM_PROMPT,
      userMessage: buildStep2UserMessage("BMW 3 series 2019", motorsDisplay, motorsCandidates),
      maxTokens: 1024,
      validate: validateStep2MotorsCarsBmwOutput,
    },
  ];

  return { name: "TradeMe Discover", cases };
}
