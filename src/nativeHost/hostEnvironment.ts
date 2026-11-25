import os from 'node:os';
import path from 'node:path';

// The first user account macOS creates; used when the process cannot report its own id.
const FIRST_MACOS_USER_ID = 501;

export function getLaunchAgentsDirectory(): string {
  return path.join(os.homedir(), 'Library/LaunchAgents');
}

export function getCurrentUserId(): number {
  return process.getuid?.() ?? FIRST_MACOS_USER_ID;
}
