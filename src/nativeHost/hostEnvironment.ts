import os from 'node:os';
import path from 'node:path';

const FIRST_MACOS_USER_ID = 501;

export function getLaunchAgentsDirectory(): string {
  return path.join(os.homedir(), 'Library/LaunchAgents');
}

export function getCurrentUserId(): number {
  return process.getuid?.() ?? FIRST_MACOS_USER_ID;
}
