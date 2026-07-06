import type { RecipeSource } from "./metadata";

export interface Listing {
  source: RecipeSource;
  title: string;
  price: number | null;
  priceDisplay: string;
  location: string;
  url: string;
  thumbnailUrl?: string;
  fulfillment?: { pickupAvailable: boolean; shippingAvailable: boolean };
  description?: string;
  isAuction?: boolean;
}

export interface ListingDetail {
  details: Array<{ key: string; value: string }>;
  description: string;
  buyNowPrice: number | null;
  reserveStatus: string;
  pickupAvailable: boolean | null;
  shippingAvailable: boolean | null;
  pickupLocation: string;
  questionsAndAnswers: Array<{ question: string; answer: string }>;
}

// Structured search progress — display wording is composed on the frontend.
export type QuickSearchProgress =
  | { phase: "loading" }
  | { phase: "counted"; totalResults: number; totalPages: number }
  | { phase: "paging"; page: number; totalPages?: number }
  | { phase: "collecting"; foundSoFar: number; isLoadingMore: boolean };

export type QuickSearchEvent =
  | { type: "criteria"; filters: Array<[string, string]> }
  | ({ type: "progress" } & QuickSearchProgress)
  | { type: "listing"; data: Listing }
  | { type: "complete" }
  | { type: "error"; message: string };

export type DeepSearchEvent =
  | { type: "progress"; index: number; total: number; title: string }
  | { type: "detail"; url: string; detail: ListingDetail }
  | { type: "complete" }
  | { type: "error"; message: string };

export type Fulfillment = "any" | "pickup" | "shipping";

export type RecipeDiscoverResult = {
  urls: string[];
  warnings: string[];
};

// An explicit, constructable dependency for tracking per-provider rate-limit cooldowns —
// see `createProviderCooldownStore` in `server/ai.ts`. Threading this on `AiConfig` (rather
// than as a hidden module-scope singleton `aiJSON` reaches into) means every caller that
// holds an `AiConfig` already has what it needs to report exhaustion, and tests can
// construct their own isolated store instead of resetting shared global state.
export type ProviderCooldownStore = {
  markExhausted: (providerKey: string, cooldownUntilMs: number) => void;
  getCooldownUntil: (providerKey: string) => number | undefined;
};

export type AiConfig = {
  url: string;
  model: string;
  apiKey: string;
  providerKey: string;
  cooldownStore: ProviderCooldownStore;
};

// `fulfillment` and `regionValue` represent user search intent (delivery preference
// and geographic region) that every classifieds recipe needs to honour, not
// Trade Me / Facebook internals. Both current recipes use them, and any future
// recipe that searches by location or delivery method will too. Keep them here.
//
// `getAiConfig` is a function rather than a resolved `AiConfig` so recipes that
// make multiple AI calls per discover request (e.g. a step-1/step-2 pipeline)
// can re-resolve it before each call — letting a mid-pipeline provider
// rotation actually take effect instead of being locked to whichever provider
// was live when the request started.
export type DiscoverContext = {
  maxPrice: number;
  fulfillment: Fulfillment;
  regionValue?: string;
  getAiConfig: () => AiConfig;
};

export interface Recipe {
  readonly name: string;
  matches(url: string): boolean;
  extractImplicitFilters(url: string): Array<[string, string]>;
  quickSearchAsync(
    url: string,
    onEvent: (event: QuickSearchEvent) => void,
    isCancelled?: () => boolean,
  ): Promise<void>;
  deepSearchAsync(
    listings: Listing[],
    onEvent: (event: DeepSearchEvent) => void,
    isCancelled?: () => boolean,
  ): Promise<void>;
}

export interface DiscoverableRecipe extends Recipe {
  buildDiscoverUrlsAsync(prompt: string, context: DiscoverContext): Promise<RecipeDiscoverResult>;
}

export function isDiscoverableRecipe(recipe: Recipe): recipe is DiscoverableRecipe {
  return typeof (recipe as DiscoverableRecipe).buildDiscoverUrlsAsync === "function";
}
