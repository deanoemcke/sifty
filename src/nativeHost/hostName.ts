// Kept apart from hostManifest.ts (which needs node:path) so the browser
// extension can import the name without pulling in Node modules.
export const NATIVE_HOST_NAME = 'com.sifty.server';
