import { basename } from "node:path";

const BASE_PORT = 5173;

export function getWorktreePort(dirPath: string): number {
  const match = basename(dirPath).match(/(\d+)$/);
  const suffix = match ? Number(match[1]) : 0;
  return BASE_PORT + suffix;
}
