import { describe, expect, it } from 'vitest';
import { djb2Hash } from './renderUtils';

describe('djb2Hash', () => {
  it('is deterministic for the same input', () => {
    expect(djb2Hash('vintage lamp')).toBe(djb2Hash('vintage lamp'));
  });

  it('produces distinct hashes for distinct inputs', () => {
    expect(djb2Hash('vintage lamp')).not.toBe(djb2Hash('vintage lamps'));
  });

  it('returns an unsigned 32-bit integer', () => {
    const hash = djb2Hash('');
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});
