// Chrome native messaging framing: each message is a 32-bit little-endian byte
// length followed by that many bytes of UTF-8 JSON, in both directions.

const LENGTH_PREFIX_BYTES = 4;

// Chrome itself allows up to 64 MiB towards the host and 1 MB back to Chrome.
// The largest real request is a cookie sync (capped at 64 KiB), so the host
// accepts far less than Chrome would send.
export const MAX_INCOMING_MESSAGE_BYTES = 1024 * 1024;
export const MAX_OUTGOING_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(message: unknown): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(message), 'utf8');
  if (jsonBytes.length > MAX_OUTGOING_MESSAGE_BYTES) {
    throw new Error(
      `Native message reply is too large: ${jsonBytes.length} bytes, limit ${MAX_OUTGOING_MESSAGE_BYTES}`
    );
  }
  const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
  lengthPrefix.writeUInt32LE(jsonBytes.length, 0);
  return Buffer.concat([lengthPrefix, jsonBytes]);
}

// Thrown for an oversized or malformed frame. Messages completed earlier in the
// same chunk are carried on the error, so the caller can still answer them.
export class NativeMessageFramingError extends Error {
  readonly messagesBeforeError: unknown[];

  constructor(reason: string, messagesBeforeError: unknown[]) {
    super(reason);
    this.name = 'NativeMessageFramingError';
    this.messagesBeforeError = messagesBeforeError;
  }
}

export type NativeMessageDecoder = {
  // Feeds the next chunk read from stdin; returns every message it completes.
  // Throws NativeMessageFramingError on an oversized or malformed message — the
  // stream cannot be resynchronised after that, so the caller should reply with
  // an error and exit.
  push(chunk: Buffer): unknown[];
};

export function createNativeMessageDecoder(): NativeMessageDecoder {
  let pendingBytes = Buffer.alloc(0);

  return {
    push(chunk) {
      pendingBytes = Buffer.concat([pendingBytes, chunk]);
      const completedMessages: unknown[] = [];

      while (pendingBytes.length >= LENGTH_PREFIX_BYTES) {
        const messageLength = pendingBytes.readUInt32LE(0);
        // Checked as soon as the prefix is known, so an absurd declared length
        // is rejected before any of its body is buffered.
        if (messageLength > MAX_INCOMING_MESSAGE_BYTES) {
          throw new NativeMessageFramingError(
            `Native message is too large: ${messageLength} bytes declared, limit ${MAX_INCOMING_MESSAGE_BYTES}`,
            completedMessages
          );
        }
        const messageEnd = LENGTH_PREFIX_BYTES + messageLength;
        if (pendingBytes.length < messageEnd) break;

        const jsonText = pendingBytes.subarray(LENGTH_PREFIX_BYTES, messageEnd).toString('utf8');
        pendingBytes = pendingBytes.subarray(messageEnd);
        try {
          completedMessages.push(JSON.parse(jsonText));
        } catch {
          throw new NativeMessageFramingError(
            'Native message body is not valid JSON',
            completedMessages
          );
        }
      }

      return completedMessages;
    },
  };
}
