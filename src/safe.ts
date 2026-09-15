import { CliError } from './errors.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, lstatSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ZodType } from 'zod';

export const LIMIT = 64 * 1024 * 1024;
export function invariant(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const json = (value: unknown) => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b, 'en'))) : child, 2) + '\n';
export function privateDir(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); invariant(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), `Not a directory: ${path}`); }
export function syncDir(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function atomicWrite(path: string, data: string | Buffer) {
  privateDir(dirname(path)); const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path); syncDir(dirname(path));
}
export function appendJournal(path: string, value: unknown) {
  privateDir(dirname(path)); const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...Object(value) }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
export function readBytes(path: string, limit = LIMIT) {
  const st = lstatSync(path); invariant(st.isFile() && st.size <= limit, `Not a bounded regular file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const data = readFileSync(fd); invariant(data.length <= limit, `File exceeds limit: ${path}`); return data; } finally { closeSync(fd); }
}
export function readJson<T>(path: string, schema: ZodType<T>): T { return schema.parse(JSON.parse(readBytes(path).toString('utf8'))); }
export function safePath(path: string) {
  invariant(path.length > 0 && Buffer.byteLength(path) <= 4096 && !isAbsolute(path) && !/[\\\x00-\x1f\x7f:]/.test(path), `Unsafe path: ${JSON.stringify(path)}`);
  invariant(path.split('/').every(p => p !== '' && p !== '.' && p !== '..' && p.toLowerCase() !== '.git'), `Unsafe path: ${path}`);
  return path;
}
export function validatePaths(paths: string[]) {
  const seen = new Set<string>(); const spellings = new Map<string, string>();
  for (const path of paths) { safePath(path);
    const parts = path.split('/'); for (let i = 1; i <= parts.length; i++) { const spelling = parts.slice(0, i).join('/'); const normalized = spelling.normalize('NFC').toLowerCase(); invariant(!spellings.has(normalized) || spellings.get(normalized) === spelling, `Case-colliding path component: ${path}`); spellings.set(normalized, spelling); }
    const key = path.normalize('NFC').toLowerCase(); invariant(!seen.has(key), `Duplicate/case-colliding path: ${path}`); seen.add(key); }
  for (const path of seen) { let parent = posix.dirname(path); while (parent !== '.') { invariant(!seen.has(parent), `File/directory collision: ${path}`); parent = posix.dirname(parent); } }
}
export function safeLink(path: string, target: string) {
  invariant(target.length > 0 && !isAbsolute(target) && !/[\\\x00-\x1f\x7f:]/.test(target), `Unsafe symlink: ${path}`);
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  invariant(resolved !== '..' && !resolved.startsWith('../'), `Escaping symlink: ${path}`);
  if (resolved !== '.') safePath(resolved);
}
export function withLock<T>(path: string, fn: () => T): T {
  privateDir(dirname(path));
  try { mkdirSync(path, { mode: 0o700 }); } catch { throw new CliError('BUSY', `Locked: ${path}; reconcile explicitly, never remove a live lock`, 'busy'); }
  try { return fn(); } finally { rmdirSync(path); }
}
export async function withAsyncLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  privateDir(dirname(path)); try { mkdirSync(path, { mode: 0o700 }); } catch { throw new CliError('BUSY', `Locked: ${path}`, 'busy', 'Reconcile explicitly; never remove an existing lock.'); }
  try { return await fn(); } finally { rmdirSync(path); }
}
export function run(command: string, args: string[], options: { cwd?: string; input?: string | Buffer; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}) {
  const result = spawnSync(command, args, { ...options, maxBuffer: options.maxBuffer ?? LIMIT, timeout: 120_000 });
  invariant(!result.error && result.status === 0, `${command} failed (${result.status}): ${result.error?.message ?? result.stderr?.toString().slice(0, 4000)}`);
  return result.stdout;
}
export function listFiles(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const ent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const p = prefix ? `${prefix}/${ent.name}` : ent.name; safePath(p);
    if (ent.isDirectory()) files.push(...listFiles(root, p)); else { invariant(ent.isFile(), `Special resource: ${p}`); files.push(p); }
  }
  return files.sort();
}
export function syncTree(root: string) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return; // Link metadata is flushed with its containing directory.
  if (stat.isDirectory()) {
    for (const name of readdirSync(root)) syncTree(join(root, name));
    syncDir(root); return;
  }
  invariant(stat.isFile(), `Special file in restoration: ${root}`);
  const fd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function removeFile(path: string) { try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
