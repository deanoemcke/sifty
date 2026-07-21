// ── Scrape depth limits ───────────────────────────────────────────────────────
// Enforced server-side before page allocation to bound resource use regardless
// of how many results a search returns or how many listings a client sends.

/** Maximum number of pages scraped per quick search run (~400–500 listings). */
export const MAX_PAGES_PER_SEARCH = 20;

/** Maximum number of listings processed in a single deep search run. */
export const MAX_DEEP_SEARCH_ITEMS = 100;

/** Maximum number of listings emitted from a single quick-search URL. */
export const MAX_RESULTS_PER_URL = 100;

/** Maximum number of photo URLs kept per scraped listing detail page. */
export const MAX_PHOTOS_PER_LISTING = 20;

// ── Discover root-probe threshold ────────────────────────────────────────────

/**
 * Upper bound (inclusive) on a categoryless root-search `TotalCount` for treating
 * it as narrow enough to use directly, skipping AI category selection.
 */
export const ROOT_SEARCH_RESULT_THRESHOLD = 50;

/**
 * Upper bound (inclusive) on a categoryless root-search `TotalCount` covering both
 * used and new conditions in a single combined (condition-less) query, used in
 * place of `ROOT_SEARCH_RESULT_THRESHOLD` when `includeNewItems` is set — since the
 * combined count spans two conditions rather than one.
 */
export const ROOT_SEARCH_COMBINED_RESULT_THRESHOLD = 100;
