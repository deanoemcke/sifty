/**
 * Runtime validation helpers for HTTP API boundaries.
 *
 * Use these at every request-body parsing site and before any value from an
 * external source touches cache writes or business logic.  Never use them to
 * validate internal function arguments — trust the type system for that.
 *
 * All helpers throw an explicit Error on failure; they never return a sentinel.
 */

export function requireString(val: unknown, field: string): string {
  if (typeof val !== "string" || val.trim() === "") {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return val;
}

export function requireArray(val: unknown, field: string): unknown[] {
  if (!Array.isArray(val) || val.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return val;
}

export function requirePositiveNumber(val: unknown, field: string): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return n;
}

/**
 * Asserts that an element from an external array has a non-empty string `url`
 * property.  Used when iterating over a client-supplied listings array before
 * passing any element to recipe code or cache writes.
 */
const DISCOVER_INPUTS_MAX_BYTES = 4096;

export function parseDiscoverInputs(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val !== "object" || Array.isArray(val)) {
    throw new Error("discoverInputs must be a plain object");
  }
  const serialised = JSON.stringify(val);
  if (serialised.length > DISCOVER_INPUTS_MAX_BYTES) {
    throw new Error("discoverInputs exceeds maximum size");
  }
  return serialised;
}

export function requireListingUrl(
  item: unknown,
  index: number,
): { url: string } & Record<string, unknown> {
  if (typeof item !== "object" || item === null) {
    throw new Error(`listings[${index}] must be an object`);
  }
  const obj = item as Record<string, unknown>;
  if (typeof obj.url !== "string" || obj.url.trim() === "") {
    throw new Error(`listings[${index}].url is required and must be a non-empty string`);
  }
  return obj as { url: string } & Record<string, unknown>;
}
