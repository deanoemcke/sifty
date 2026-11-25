import { describe, expect, it } from 'vitest';
import {
  createNativeMessageDecoder,
  encodeNativeMessage,
  MAX_INCOMING_MESSAGE_BYTES,
  MAX_OUTGOING_MESSAGE_BYTES,
} from './nativeMessaging';

describe('native message framing', () => {
  it('decodes a message back to what was encoded', () => {
    const decoder = createNativeMessageDecoder();

    const decodedMessages = decoder.push(encodeNativeMessage({ type: 'getStatus', id: 7 }));

    expect(decodedMessages).toEqual([{ type: 'getStatus', id: 7 }]);
  });

  it('prefixes the JSON with its byte length as a 32-bit little-endian integer', () => {
    const encoded = encodeNativeMessage({ ok: true });

    expect(encoded.readUInt32LE(0)).toBe(Buffer.byteLength('{"ok":true}'));
    expect(encoded.subarray(4).toString('utf8')).toBe('{"ok":true}');
  });

  it('waits for the rest of a message that arrives split across chunks', () => {
    const decoder = createNativeMessageDecoder();
    const encoded = encodeNativeMessage({ type: 'getStatus' });

    expect(decoder.push(encoded.subarray(0, 6))).toEqual([]);
    expect(decoder.push(encoded.subarray(6))).toEqual([{ type: 'getStatus' }]);
  });

  it('waits when even the length prefix is split across chunks', () => {
    const decoder = createNativeMessageDecoder();
    const encoded = encodeNativeMessage({ type: 'getStatus' });

    expect(decoder.push(encoded.subarray(0, 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(2))).toEqual([{ type: 'getStatus' }]);
  });

  it('returns every message when several arrive in one chunk', () => {
    const decoder = createNativeMessageDecoder();
    const twoMessages = Buffer.concat([
      encodeNativeMessage({ type: 'first' }),
      encodeNativeMessage({ type: 'second' }),
    ]);

    expect(decoder.push(twoMessages)).toEqual([{ type: 'first' }, { type: 'second' }]);
  });

  it('keeps the start of the next message when a chunk ends partway through it', () => {
    const decoder = createNativeMessageDecoder();
    const second = encodeNativeMessage({ type: 'second' });
    const chunk = Buffer.concat([encodeNativeMessage({ type: 'first' }), second.subarray(0, 5)]);

    expect(decoder.push(chunk)).toEqual([{ type: 'first' }]);
    expect(decoder.push(second.subarray(5))).toEqual([{ type: 'second' }]);
  });

  it('counts bytes, not characters, for non-ASCII text', () => {
    const decoder = createNativeMessageDecoder();

    expect(decoder.push(encodeNativeMessage({ name: 'Café ☕' }))).toEqual([{ name: 'Café ☕' }]);
  });

  it('rejects a declared length above the cap before any of the body arrives', () => {
    const decoder = createNativeMessageDecoder();
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(MAX_INCOMING_MESSAGE_BYTES + 1, 0);

    expect(() => decoder.push(lengthPrefix)).toThrow(/too large/);
  });

  it('rejects a message whose body is not valid JSON', () => {
    const decoder = createNativeMessageDecoder();
    const notJson = Buffer.from('{oops', 'utf8');
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(notJson.length, 0);

    expect(() => decoder.push(Buffer.concat([lengthPrefix, notJson]))).toThrow(/not valid JSON/);
  });

  it('refuses to encode a reply larger than Chrome accepts', () => {
    const oversizedReply = { text: 'x'.repeat(MAX_OUTGOING_MESSAGE_BYTES) };

    expect(() => encodeNativeMessage(oversizedReply)).toThrow(/too large/);
  });
});
