// ── SSE streaming ─────────────────────────────────────────────────────────────
// Shared transport for all streaming endpoints: POSTs JSON, reads the response
// as a server-sent-event stream, and invokes onData per parsed `data:` line.

export async function streamPostAsync(
  endpoint: string,
  body: unknown,
  onData: (data: Record<string, unknown>) => void,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = (await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }))) as { error?: string };
    throw new Error(errorBody.error ?? `HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");
  const textDecoder = new TextDecoder();
  let streamBuffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    streamBuffer += textDecoder.decode(value, { stream: true });
    const lines = streamBuffer.split("\n");
    streamBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          onData(JSON.parse(line.slice(6)));
        } catch {
          /* ignore */
        }
      }
    }
  }
}
