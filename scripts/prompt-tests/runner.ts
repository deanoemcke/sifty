#!/usr/bin/env tsx
// AI Prompt Test Runner
// Usage:
//   tsx scripts/prompt-tests/runner.ts                          (replay saved fixtures)
//   tsx scripts/prompt-tests/runner.ts --live                   (call all providers)
//   tsx scripts/prompt-tests/runner.ts --live --capture         (call and save fixtures)
//   tsx scripts/prompt-tests/runner.ts --live --provider groq   (single provider)

import * as path from "node:path";
import * as fs from "node:fs";
import Database from "better-sqlite3";
import { aiJSON } from "../../src/server/ai";
import { aiFilterSuite } from "./suites/aiFilterSuite";
import { buildTrademeDiscoverSuiteAsync } from "./suites/trademeDiscoverSuite";
import { buildAllProviderConfigs, buildProviderConfig, PROVIDER_NAMES } from "./providers";
import { loadFixture, saveFixture } from "./fixtureStore";
import type { PromptTestSuite, TestResult } from "./types";

// ── CLI argument parsing ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isLive = args.includes("--live") || args.includes("--capture");
const isCapture = args.includes("--capture");

const providerArgIndex = args.indexOf("--provider");
const singleProvider = providerArgIndex !== -1 ? args[providerArgIndex + 1] : null;

const suiteArgIndex = args.indexOf("--suite");
const singleSuite = suiteArgIndex !== -1 ? args[suiteArgIndex + 1] : null;

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const DB_PATH = process.env.CACHE_DB_PATH ?? path.resolve(__dirname, "../../.cache/cache.db");

// ── Output helpers ────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function coloured(text: string, colour: string): string {
  return `${colour}${text}${RESET}`;
}

function statusSymbol(status: TestResult["status"]): string {
  switch (status) {
    case "pass": return coloured("✓", GREEN);
    case "fail": return coloured("✗", RED);
    case "error": return coloured("!", RED);
    case "quota-exceeded": return coloured("~", YELLOW);
    case "no-fixture": return coloured("?", YELLOW);
  }
}

// ── Core runner logic ─────────────────────────────────────────────────────────

function isQuotaExhausted(err: Error): boolean {
  return err.message.includes("[429]");
}

async function runCase(
  suiteId: string,
  providerName: string,
  config: { url: string; model: string; apiKey: string },
  testCase: import("./types").PromptTestCase,
  live: boolean,
  capture: boolean,
): Promise<TestResult> {
  const start = Date.now();
  const base = { suiteId, testId: testCase.id, label: testCase.label, provider: providerName };

  let response: unknown;

  if (live) {
    try {
      response = await aiJSON(config, testCase.id, testCase.systemMessage, testCase.userMessage, testCase.maxTokens);
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err as Error;
      return {
        ...base,
        status: isQuotaExhausted(error) ? "quota-exceeded" : "error",
        durationMs,
        error: error.message,
      };
    }
    if (capture) {
      saveFixture(FIXTURES_DIR, providerName, testCase.id, config.model, response);
    }
  } else {
    const fixture = loadFixture(FIXTURES_DIR, providerName, testCase.id);
    if (!fixture) {
      return { ...base, status: "no-fixture", durationMs: 0 };
    }
    response = fixture.response;
  }

  try {
    testCase.validate(response);
    return { ...base, status: "pass", durationMs: Date.now() - start, output: response };
  } catch (err) {
    return {
      ...base,
      status: "fail",
      durationMs: Date.now() - start,
      error: (err as Error).message,
      output: response,
    };
  }
}

function printReport(results: TestResult[]): void {
  let currentSuite = "";
  for (const r of results) {
    if (r.suiteId !== currentSuite) {
      currentSuite = r.suiteId;
      console.log(`\n${BOLD}Suite: ${currentSuite}${RESET}`);
    }
    const sym = statusSymbol(r.status);
    const dur = r.durationMs > 0 ? coloured(` ${r.durationMs}ms`, DIM) : "";
    const prov = r.provider.padEnd(12);
    const id = r.testId.padEnd(40);
    console.log(`  ${sym} ${id} ${prov}${dur}`);
    if (r.error && r.status !== "no-fixture") {
      console.log(`      ${coloured(r.error, RED)}`);
    }
  }
}

function printSummary(results: TestResult[]): void {
  const total = results.length;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail" || r.status === "error").length;
  const skipped = results.filter((r) => r.status === "quota-exceeded" || r.status === "no-fixture").length;

  console.log("\n" + "─".repeat(60));
  const parts: string[] = [];
  if (passed > 0) parts.push(coloured(`${passed} passed`, GREEN));
  if (failed > 0) parts.push(coloured(`${failed} failed`, RED));
  if (skipped > 0) parts.push(coloured(`${skipped} skipped`, YELLOW));
  if (parts.length === 0) parts.push("no results");
  console.log(parts.join("  ") + coloured(`  (${total} total)`, DIM));
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate provider arg early
  if (singleProvider && !PROVIDER_NAMES.includes(singleProvider)) {
    console.error(`Unknown provider "${singleProvider}". Valid options: ${PROVIDER_NAMES.join(", ")}`);
    process.exit(1);
  }

  // Determine which providers to test
  let providerConfigs: Record<string, { url: string; model: string; apiKey: string }>;
  if (!isLive) {
    // Fixture mode: test all providers that have saved fixtures
    const savedProviders = fs.existsSync(FIXTURES_DIR)
      ? fs.readdirSync(FIXTURES_DIR).filter((name) => fs.statSync(path.join(FIXTURES_DIR, name)).isDirectory())
      : [];
    if (savedProviders.length === 0) {
      console.error("No saved fixtures found. Run with --live --capture first to generate them.");
      process.exit(1);
    }
    // Build dummy configs for fixture mode (apiKey not needed)
    providerConfigs = Object.fromEntries(savedProviders.map((name) => [name, { url: "", model: "", apiKey: "" }]));
  } else if (singleProvider) {
    providerConfigs = { [singleProvider]: buildProviderConfig(singleProvider) };
  } else {
    providerConfigs = buildAllProviderConfigs();
    if (Object.keys(providerConfigs).length === 0) {
      console.error("No provider API keys found. Set at least one of: GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY");
      process.exit(1);
    }
    const missing = PROVIDER_NAMES.filter((n) => !providerConfigs[n]);
    if (missing.length > 0) {
      console.warn(`${YELLOW}Warning: skipping providers with missing API keys: ${missing.join(", ")}${RESET}`);
    }
  }

  // Build suites
  const allSuites: PromptTestSuite[] = [aiFilterSuite];

  if (!singleSuite || singleSuite === "trademe-discover") {
    if (!fs.existsSync(DB_PATH)) {
      console.warn(`${YELLOW}Warning: DB not found at ${DB_PATH} — skipping TradeMe Discover suite.${RESET}`);
      console.warn(`${YELLOW}Set CACHE_DB_PATH env var to override.${RESET}`);
    } else {
      const db = new Database(DB_PATH, { readonly: true });
      allSuites.push(await buildTrademeDiscoverSuiteAsync(db));
    }
  }

  const suites = singleSuite === "ai-filter" ? [aiFilterSuite] : allSuites;

  // Run all suites × cases × providers sequentially
  const results: TestResult[] = [];

  for (const suite of suites) {
    for (const testCase of suite.cases) {
      for (const [providerName, config] of Object.entries(providerConfigs)) {
        process.stdout.write(`  Running ${testCase.id} [${providerName}]...\r`);
        const result = await runCase(suite.name, providerName, config, testCase, isLive, isCapture);
        results.push(result);
      }
    }
  }

  process.stdout.write(" ".repeat(60) + "\r"); // clear progress line
  printReport(results);
  printSummary(results);

  const hasFailures = results.some((r) => r.status === "fail" || r.status === "error");
  process.exit(hasFailures ? 1 : 0);
}

main().catch((err: Error) => {
  console.error(coloured(`Fatal: ${err.message}`, RED));
  process.exit(1);
});
