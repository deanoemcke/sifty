import { describe, expect, it } from 'vitest';
import { hashFingerprintParts } from './alerts';

describe('hashFingerprintParts', () => {
  it('is deterministic for the same parts', () => {
    expect(hashFingerprintParts(['a', 'b', 'c'])).toBe(hashFingerprintParts(['a', 'b', 'c']));
  });

  it('differs when a part differs', () => {
    expect(hashFingerprintParts(['a', 'b'])).not.toBe(hashFingerprintParts(['a', 'c']));
  });

  it('treats null and undefined parts as an empty string', () => {
    expect(hashFingerprintParts(['a', null])).toBe(hashFingerprintParts(['a', '']));
    expect(hashFingerprintParts(['a', undefined])).toBe(hashFingerprintParts(['a', '']));
  });

  it('returns a compact hex string, not the raw composite key', () => {
    const hash = hashFingerprintParts(['distinctive-part-one', 'distinctive-part-two']);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash).not.toContain('distinctive-part-one');
  });
});
