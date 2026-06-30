// Server-side only — POST /api/discover route handler.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DiscoverContext, Fulfillment } from "../../lib/recipes/base";
import { getAllRecipes } from "../recipes/registry";
import { getAIConfig } from "../ai";
import { requirePositiveNumber, requireString } from "../../lib/validate";
import { readBody, sendJSON } from "../helpers";

const SENSITIVE_TOKEN_PATTERNS = [
  /sk-[a-zA-Z0-9]+/g,
  /api[_-]?key[=:]\S+/gi,
  /bearer \S+/gi,
];

export function sanitiseWarningMessage(reason: unknown): string {
  const rawMessage = reason instanceof Error ? reason.message : "Recipe failed";
  return SENSITIVE_TOKEN_PATTERNS.reduce(
    (message, pattern) => message.replace(pattern, "[redacted]"),
    rawMessage,
  );
}

type DiscoverResult = {
  urls: string[];
  filters: { maxPrice: number; shippingAvailable: boolean; pickupAvailable: boolean };
  name: string;
  warnings: string[];
};

export async function discoverCategoriesAsync(
  discoveryPrompt: string,
  discoveryMaxPrice: number,
  discoveryFulfillment: Fulfillment,
  discoveryRegion: string | undefined,
): Promise<DiscoverResult> {
  const aiConfig = getAIConfig();
  const context: DiscoverContext = {
    maxPrice: discoveryMaxPrice,
    fulfillment: discoveryFulfillment,
    regionValue: discoveryRegion,
    aiConfig,
  };
  const settled = await Promise.allSettled(
    getAllRecipes().map((r) => r.buildDiscoverUrlsAsync(discoveryPrompt, context)),
  );
  const urls = settled.flatMap((r) => (r.status === "fulfilled" ? r.value.urls : []));
  const warnings = [
    ...settled.flatMap((r) => (r.status === "fulfilled" ? r.value.warnings : [])),
    ...settled
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => sanitiseWarningMessage(r.reason)),
  ];
  if (urls.length === 0)
    throw new Error(`No URLs returned from any recipe. Errors: ${warnings.join("; ")}`);
  const filters = {
    maxPrice: discoveryMaxPrice,
    shippingAvailable: discoveryFulfillment !== "pickup",
    pickupAvailable: discoveryFulfillment !== "shipping",
  };
  return { urls, filters, name: discoveryPrompt.trim(), warnings };
}

export async function handleDiscover(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let discoveryPrompt: string;
  let discoveryMaxPrice: number;
  try {
    discoveryPrompt = requireString(rawBody.prompt, "prompt");
    discoveryMaxPrice = requirePositiveNumber(rawBody.maxPrice, "maxPrice");
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message });
    return;
  }
  const VALID_FULFILLMENTS = new Set<Fulfillment>(["any", "pickup", "shipping"]);
  const rawFulfillment = typeof rawBody.fulfillment === "string" ? rawBody.fulfillment : "any";
  const discoveryFulfillment: Fulfillment = VALID_FULFILLMENTS.has(rawFulfillment as Fulfillment)
    ? (rawFulfillment as Fulfillment)
    : "any";
  const discoveryRegion =
    typeof rawBody.regionValue === "string" && rawBody.regionValue.trim()
      ? rawBody.regionValue
      : undefined;

  try {
    const result = await discoverCategoriesAsync(
      discoveryPrompt,
      discoveryMaxPrice,
      discoveryFulfillment,
      discoveryRegion,
    );
    sendJSON(response, 200, result);
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
  }
}
