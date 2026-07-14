// Server-side only — listing identity hashing for the alert scheduler.
// node:crypto is Node-only, so this stays out of src/lib (bundled into the
// frontend too).
//
// Each recipe's own computeAlertFingerprint (see the Recipe interface in
// src/lib/recipes/base.ts) composes its own stable-field list into this
// helper — the field selection is platform-specific, but the hashing
// algorithm is shared.

import { createHash } from 'node:crypto';

export function hashFingerprintParts(parts: Array<string | number | null | undefined>): string {
  const composite = parts.map((part) => part ?? '').join('\0');
  return createHash('sha256').update(composite).digest('hex');
}
