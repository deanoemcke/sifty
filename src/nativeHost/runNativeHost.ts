import type { Readable, Writable } from 'node:stream';
import { describeError } from './describeError';
import { handleNativeHostMessageAsync, type NativeHostDependencies } from './handleMessage';
import { isRecord } from './isRecord';
import {
  createNativeMessageDecoder,
  encodeNativeMessage,
  type NativeMessageDecoder,
  NativeMessageFramingError,
} from './nativeMessaging';

export type NativeHostOutcome = 'input-closed' | 'protocol-error';

function writeFramedAsync(output: Writable, framedMessage: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(framedMessage, (error) => (error ? reject(error) : resolve()));
  });
}

export async function writeReplyAsync(output: Writable, reply: unknown): Promise<void> {
  let framedReply: Buffer;
  try {
    framedReply = encodeNativeMessage(reply);
  } catch (error) {
    const logName =
      isRecord(reply) && typeof reply.logName === 'string' ? reply.logName : undefined;
    framedReply = encodeNativeMessage({
      ok: false,
      ...(logName === undefined ? {} : { logName }),
      error: describeError(error),
    });
  }
  await writeFramedAsync(output, framedReply);
}

export async function runNativeHostAsync(
  input: Readable,
  output: Writable,
  dependencies: NativeHostDependencies
): Promise<NativeHostOutcome> {
  const decoder = createNativeMessageDecoder();
  try {
    return await answerMessagesAsync(input, output, dependencies, decoder);
  } finally {
    dependencies.logStreams.stopAll();
  }
}

async function answerMessagesAsync(
  input: Readable,
  output: Writable,
  dependencies: NativeHostDependencies,
  decoder: NativeMessageDecoder
): Promise<NativeHostOutcome> {
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
      await writeReplyAsync(output, { ok: false, error: framingError.message });
      return 'protocol-error';
    }
  }

  return 'input-closed';
}
