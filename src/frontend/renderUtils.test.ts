import { describe, expect, it } from 'vitest';
import { promptHash } from './renderUtils';

describe('promptHash', () => {
  it('is deterministic for the same input', () => {
    expect(promptHash('vintage lamp')).toBe(promptHash('vintage lamp'));
  });

  it('produces distinct hashes for distinct inputs', () => {
    expect(promptHash('vintage lamp')).not.toBe(promptHash('vintage lamps'));
  });

  it('returns an unsigned 32-bit integer', () => {
    const hash = promptHash('');
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});
