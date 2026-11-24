import fs from 'node:fs';

// A log can grow without bound, so only its final bytes are ever read. This
// also keeps the reply well inside Chrome's 1 MB limit for native messages.
export const MAX_LOG_TAIL_BYTES = 256 * 1024;

export type LogTail = { isPresent: boolean; lines: string[] };

export function readLogTail(logFilePath: string, lineCount: number): LogTail {
  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(logFilePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { isPresent: false, lines: [] };
    throw error;
  }

  try {
    const fileSizeBytes = fs.fstatSync(fileDescriptor).size;
    const bytesToRead = Math.min(fileSizeBytes, MAX_LOG_TAIL_BYTES);
    const startOffset = fileSizeBytes - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fileDescriptor, buffer, 0, bytesToRead, startOffset);

    const lines = buffer.toString('utf8').split('\n');
    // Reading from mid-file starts partway through a line (and possibly a
    // multi-byte character), so that fragment is dropped.
    if (startOffset > 0) lines.shift();
    // A file ending in a newline splits into a final empty string.
    if (lines.at(-1) === '') lines.pop();

    return { isPresent: true, lines: lines.slice(-lineCount) };
  } finally {
    fs.closeSync(fileDescriptor);
  }
}
