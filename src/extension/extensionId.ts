import crypto from 'node:crypto';

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const EXTENSION_ID_LENGTH = 32;

// Chrome derives an extension's ID from its public key: the first 32 hex digits
// of the SHA-256 of the DER-encoded key, with each digit 0-9a-f rewritten as a-p.
export function computeExtensionId(publicKeyBase64: string): string {
  if (!BASE64_PATTERN.test(publicKeyBase64) || publicKeyBase64.length % 4 !== 0) {
    throw new Error('Extension public key must be non-empty base64');
  }

  const publicKeyDer = Buffer.from(publicKeyBase64, 'base64');
  const hexDigits = crypto
    .createHash('sha256')
    .update(publicKeyDer)
    .digest('hex')
    .slice(0, EXTENSION_ID_LENGTH);

  return [...hexDigits]
    .map((hexDigit) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(hexDigit, 16)))
    .join('');
}
