// Browser-safe — no Node/Playwright imports.
// Update this list when adding a new recipe.
const SUPPORTED_HOSTNAMES = ['trademe.co.nz'];

export function canHandleUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return SUPPORTED_HOSTNAMES.some(h => hostname.endsWith(h));
  } catch {
    return false;
  }
}
