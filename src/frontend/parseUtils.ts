export function parseMaxPrice(raw: string): number | undefined {
  const value = parseFloat(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
