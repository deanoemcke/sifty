// The native host's read loop: framed requests in on `input` (Chrome's stdin
// pipe), framed replies out on `output`. Taking streams as arguments keeps it
// testable without a real process.

import type { Readable, Writable } from 'node:stream';
import { describeError } from './describeError';
import { handleNativeHostMessageAsync, type NativeHostDependencies } from './handleMessage';
import {
  createNativeMessageDecoder,
  encodeNativeMessage,
  NativeMessageFramingError,
} from './nativeMessaging';

export type NativeHostOutcome = 'input-closed' | 'protocol-error';

function writeFramedAsync(output: Writable, framedMessage: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(framedMessage, (error) => (error ? reject(error) : resolve()));
  });
}

// A reply Chrome would reject (over 1 MB) is replaced by an error reply, so
// the extension is told why instead of seeing the host exit with no answer.
async function writeReplyAsync(output: Writable, reply: unknown): Promise<void> {
  let framedReply: Buffer;
  try {
    framedReply = encodeNativeMessage(reply);
  } catch (error) {
    framedReply = encodeNativeMessage({ ok: false, error: describeError(error) });
  }
  await writeFramedAsync(output, framedReply);
}

export async function runNativeHostAsync(
  input: Readable,
  output: Writable,
  dependencies: NativeHostDependencies
): Promise<NativeHostOutcome> {
  const decoder = createNativeMessageDecoder();

  for await (const chunk of input) {
    let messages: unknown[];
    let framingError: NativeMessageFramingError | undefined;
    try {
      messages = decoder.push(chunk as Buffer);
    } catch (error) {
      if (!(error instanceof NativeMessageFramingError)) throw error;
      framingError = error;
      messages = error.messagesBeforeError;
    }

    for (const message of messages) {
      await writeReplyAsync(output, await handleNativeHostMessageAsync(message, dependencies));
    }

    if (framingError) {
      // The stream cannot be re-synchronised after a bad frame: answer once, stop.
      await writeReplyAsync(output, { ok: false, error: framingError.message });
      return 'protocol-error';
    }
  }

  return 'input-closed';
}
