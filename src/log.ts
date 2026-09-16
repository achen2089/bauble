import { constants, closeSync, fstatSync, openSync, readSync, writeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { invariant, syncDir } from './safe.js';
export const LOG_BYTES = 256 * 1024;
export const LogCursor = z.object({ identity: z.string().max(256), offset: z.number().int().nonnegative() }).strict();
export type LogCursor = z.infer<typeof LogCursor>;
export const LogChunk = z.object({ text: z.string(), cursor: LogCursor.nullable(), reset: z.boolean(), caughtUp: z.boolean() }).strict();
export type LogChunk = z.infer<typeof LogChunk>;
/** Byte cursor on a bounded regular file; never reads a transcript or loads a native runtime. */
export function readLog(path: string, cursor?: LogCursor): LogChunk {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', cursor: null, reset: cursor !== undefined, caughtUp: true }; throw error; }
  try {
    const st = fstatSync(fd); invariant(st.isFile(), 'Log must be a regular file');
    const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`; const reset = !!cursor && (cursor.identity !== identity || cursor.offset > st.size);
    let start = cursor && !reset ? cursor.offset : Math.max(0, st.size - LOG_BYTES);
    const bytes = Buffer.alloc(Math.min(LOG_BYTES, st.size - start)); const count = readSync(fd, bytes, 0, bytes.length, start); let first = 0; let end = count;
    if (!cursor || reset) while (first < end && (bytes[first]! & 0xc0) === 0x80) first++;
    // Leave any incomplete final code point for the next read, including an append mid-codepoint.
    if (end > first) { let lead = end - 1; while (lead > first && (bytes[lead]! & 0xc0) === 0x80) lead--; const b = bytes[lead]!; const width = b < 0x80 ? 1 : b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 1; if (end - lead < width) end = lead; }
    const chunk = bytes.subarray(first, end); const text = chunk.toString('utf8'); invariant(Buffer.from(text).equals(chunk), 'Log contains invalid UTF-8');
    start += end; return { text, cursor: { identity, offset: start }, reset, caughtUp: start >= st.size || end < count };
  } finally { closeSync(fd); }
}

/** Preserve cursor identity while appending the existing serialized/redacted message format. */
export function appendLog(path: string, text: string) {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number; let created = false;
  try { fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; fd = openSync(path, flags); }
  try {
    invariant(fstatSync(fd).isFile(), 'Log must be a regular file');
    const bytes = Buffer.from(text); let offset = 0;
    while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); invariant(count > 0, 'Log append made no progress'); offset += count; }
    fsyncSync(fd); if (created) syncDir(dirname(path));
  } finally { closeSync(fd); }
}
