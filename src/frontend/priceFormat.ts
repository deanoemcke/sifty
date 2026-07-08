export function formatListingPrice(price: number | null): string {
  if (price === null) return "Price on request";
  if (price === 0) return "Free";
  return `$${Math.round(price).toLocaleString()}`;
}
