import fs from 'node:fs';

export const MAX_LOG_TAIL_BYTES = 256 * 1024;

export type LogTail = { isLogFilePresent: boolean; logLines: string[] };

export function readLogTail(logFilePath: string, lineCount: number): LogTail {
  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(logFilePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { isLogFilePresent: false, logLines: [] };
    throw error;
  }

  try {
    const fileSizeBytes = fs.fstatSync(fileDescriptor).size;
    const bytesToRead = Math.min(fileSizeBytes, MAX_LOG_TAIL_BYTES);
    const startOffset = fileSizeBytes - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fileDescriptor, buffer, 0, bytesToRead, startOffset);

    const lines = buffer.toString('utf8').split('\n');
    const startsMidLine = startOffset > 0;
    if (startsMidLine) lines.shift();
    const endsWithNewline = lines.at(-1) === '';
    if (endsWithNewline) lines.pop();

    return { isLogFilePresent: true, logLines: lines.slice(-lineCount) };
  } finally {
    fs.closeSync(fileDescriptor);
  }
}
