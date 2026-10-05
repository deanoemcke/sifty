// Server-side only — sends alert notifications via the local OpenClaw
// Signal bridge.

const NOTIFY_URL = 'http://127.0.0.1:8091/notify';
const NOTIFY_TIMEOUT_MS = 10_000;
const MAX_ERROR_DETAIL_LENGTH = 500;

export type SignalNotificationOptions = {
  image?: string;
};

export async function sendSignalNotificationAsync(
  message: string,
  options?: SignalNotificationOptions
): Promise<void> {
  const token = process.env.OPENCLAW_BEARER_TOKEN;
  if (!token) throw new Error('OPENCLAW_BEARER_TOKEN environment variable is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, ...(options?.image ? { image: options.image } : {}) }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorDetail = await readErrorDetailAsync(response);
    throw new Error(
      `Signal notification failed: ${response.status} ${response.statusText}${errorDetail}`
    );
  }
}

// The proxy collapses every downstream failure (e.g. a signal-cli attachment
// error) into a bare 400, with the real reason only in the response body —
// without it the log gives no clue why a send failed.
async function readErrorDetailAsync(response: Response): Promise<string> {
  let body: string;
  try {
    body = (await response.text()).trim();
  } catch {
    return '';
  }
  if (!body) return '';
  const truncatedBody =
    body.length > MAX_ERROR_DETAIL_LENGTH ? `${body.slice(0, MAX_ERROR_DETAIL_LENGTH)}…` : body;
  return ` — ${truncatedBody}`;
}
