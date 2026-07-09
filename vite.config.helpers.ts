import { basename } from "node:path";

const BASE_PORT = 5173;

export function getWorktreeLabel(dirPath: string): string | null {
  const name = basename(dirPath);
  return /\d+$/.test(name) ? name : null;
}

export function getWorktreePort(dirPath: string): number {
  const label = getWorktreeLabel(dirPath);
  const match = label?.match(/(\d+)$/);
  const suffix = match ? Number(match[1]) : 0;
  return BASE_PORT + suffix;
}
