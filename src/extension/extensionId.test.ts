import { describe, expect, it } from 'vitest';
import { computeExtensionId } from './extensionId';

const VECTOR_PUBLIC_KEY_BASE64 =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqr2vpiozP4P3JKG9QhOxsHywcKAYfrHEl1X6xPFfPpDwu+bsCimQ8K17cTmg/0OrJoMG6aA4Qj5XqGq5ORYq3EdRK7mwwu3QytNGoweFk1JWhMzbYOV0B5zOZmZew4AYCf8hXP2I8usc2earS5GkL7CdTLXxmut3I3iaekbn3MCXfGLmwwoPijErOTQ88CmjXUJ1E24uAJaKBRDFqCmgLM40AWBMg0PsOEgTukfDoVjUA+SS9LacyHnITD7ZQEHF9aMDz2lR8logPiIKQE78lGRxmJem9TZ8PZIrozVs3S5mo9tW3gTeSdQoYt5THjOZcY3qWc12Qylf6WK9kq/x1QIDAQAB';
const VECTOR_EXTENSION_ID = 'gilhdcihjhphhdpfmdoacmlhlicocmeb';

describe('computeExtensionId', () => {
  it("derives Chrome's extension ID from the manifest's public key", () => {
    expect(computeExtensionId(VECTOR_PUBLIC_KEY_BASE64)).toBe(VECTOR_EXTENSION_ID);
  });

  it('produces an ID the native host manifest builder accepts', () => {
    expect(computeExtensionId(VECTOR_PUBLIC_KEY_BASE64)).toMatch(/^[a-p]{32}$/);
  });

  it('rejects an empty key', () => {
    expect(() => computeExtensionId('')).toThrow(/public key/);
  });

  it('rejects a key that is not base64', () => {
    expect(() => computeExtensionId('not base64 !!!')).toThrow(/public key/);
  });
});
