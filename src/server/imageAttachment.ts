// Server-side only — best-effort fetch of a listing's thumbnail for
// attaching to a Signal notification. Every failure path (bad status,
// disallowed type, oversized, network error, timeout) degrades to
// `undefined` rather than throwing: a broken thumbnail must never block the
// text alert it would have accompanied.

export const IMAGE_FETCH_TIMEOUT_MS = 8_000;
// Matches the Signal proxy's decoded-size cap exactly, so nothing fetched
// here is ever rejected downstream for being too large.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

function warnSkipped(imageUrl: string, reason: string): void {
  console.warn(`[scheduler] thumbnail attachment skipped for ${imageUrl}: ${reason}`);
}

export async function fetchListingImageAttachmentAsync(
  imageUrl: string | undefined
): Promise<string | undefined> {
  if (!imageUrl) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(imageUrl, { signal: controller.signal });
    if (!response.ok) {
      warnSkipped(imageUrl, `HTTP ${response.status}`);
      return undefined;
    }

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
      warnSkipped(imageUrl, `unsupported content-type "${contentType}"`);
      return undefined;
    }

    if (!response.body) {
      warnSkipped(imageUrl, 'empty response body');
      return undefined;
    }

    // Streamed and capped as chunks arrive, rather than buffering the whole
    // response first — an oversized or malicious body is abandoned as soon
    // as the running total crosses the limit, not after fully downloading it.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMAGE_BYTES) {
        controller.abort();
        warnSkipped(imageUrl, `exceeds ${MAX_IMAGE_BYTES} bytes`);
        return undefined;
      }
      chunks.push(value);
    }

    const base64Data = Buffer.concat(chunks).toString('base64');
    return `data:${contentType};base64,${base64Data}`;
  } catch (err) {
    warnSkipped(imageUrl, (err as Error).message);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
