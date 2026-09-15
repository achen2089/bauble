import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, mkdirSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, relative, resolve, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import ignore, { type Ignore } from 'ignore';
import { Blobs } from './blobs.js';
import type { Workspace, FileEntry } from './schema.js';
import { invariant, json, privateDir, readBytes, safeLink, safePath } from './safe.js';
import { forbidden, sensitive, validateInventory } from './workspace.js';

const excludedDirectory = new Set(['.git', 'node_modules', '.pi', '.agents', '.config', '.cache', '.local', '.ssh', '.aws', '.gnupg', '.bauble']);
export function safeFolderRoot(input: string, state?: string) {
  const root = resolve(input); invariant(realpathSync(root) === root, 'Folder path must be canonical, without symlink ancestors');
  invariant(lstatSync(root).isDirectory() && root !== sep && root !== homedir(), 'Select a project folder, not filesystem root or home');
  invariant(!sensitive(root) && !root.split(sep).some(p => excludedDirectory.has(p.toLowerCase())), 'Sensitive/state/dependency/credential folder cannot be selected');
  if (state) { const storage = resolve(state); invariant(root !== storage && !root.startsWith(storage + sep) && !storage.startsWith(root + sep), 'Workspace must not contain or be inside Bauble state'); }
  return root;
}
export function folderInventory(root: string, blobs: Blobs): Pick<Workspace, 'head' | 'index' | 'files' | 'excluded'> {
  const files: FileEntry[] = []; const excluded: Workspace['excluded'] = [];
  function walk(prefix: string, parents: { base: string; rules: Ignore }[]) {
    const directory = join(root, prefix); const rules = [...parents];
    const ignorePath = join(directory, '.gitignore');
    if (existsSync(ignorePath)) rules.push({ base: prefix, rules: ignore().add(readBytes(ignorePath).toString('utf8')) });
    for (const raw of readdirSync(directory, { encoding: 'buffer' })) {
      const name = raw.toString('utf8'); invariant(Buffer.from(name).equals(raw), 'Non-UTF-8 filename');
      const path = prefix ? `${prefix}/${name}` : name;
      if (excludedDirectory.has(name.toLowerCase())) { excluded.push({ path, reason: 'State, dependency or ambient runtime directory (not traversed)' }); continue; }
      safePath(path); const full = join(root, path); const stat = lstatSync(full);
      if (forbidden(path)) throw new Error(`Never transfer credential path: ${path}`);
      if (sensitive(path)) { excluded.push({ path, reason: 'Likely secret (not transferred)' }); continue; }
      // Deeper explicit rules override ancestor file rules; excluded directories are never traversed.
      let ignored = false;
      for (const r of rules) { const match = r.rules.test(relative(join(root, r.base), full) + (stat.isDirectory() ? '/' : '')); if (match.ignored || match.unignored) ignored = match.ignored; }
      if (ignored) { excluded.push({ path, reason: 'Git ignored (not traversed)' }); continue; }
      if (stat.isDirectory()) walk(path, rules);
      else if (stat.isSymbolicLink()) { const target = readlinkSync(full); safeLink(path, target); invariant(!sensitive(resolve(dirname(path), target)), `Sensitive symlink target: ${path}`); files.push({ path, type: 'symlink', mode: '120000', target }); }
      else { invariant(stat.isFile(), `Special file unsupported: ${path}`); files.push({ path, type: 'file', mode: stat.mode & 0o111 ? '100755' : '100644', hash: blobs.put(readBytes(full)) }); }
    }
  }
  walk('', []); files.sort((a, b) => a.path.localeCompare(b.path, 'en')); excluded.sort((a, b) => a.path.localeCompare(b.path, 'en')); validateInventory(files);
  // A link must point at an included file/directory, never an excluded or external resource.
  for (const f of files.filter(f => f.type === 'symlink')) { const target = relative(root, resolve(root, dirname(f.path), f.target!)); invariant(files.some(other => other.type === 'file' && (other.path === target || other.path.startsWith(target + '/'))), `Symlink target not included: ${f.path}`); }
  return { head: null, index: [], files, excluded };
}
export function captureFolder(root: string, blobs: Blobs): Workspace {
  const before = folderInventory(root, blobs); invariant(json(before) === json(folderInventory(root, blobs)), 'Folder changed during capture');
  return { ...before, bundle: null, historySensitive: [], historyApproved: [], sensitiveApproved: [] };
}
export function restoreFolder(workspace: Workspace, blobs: Blobs, destination: string) {
  invariant(workspace.head === null && workspace.bundle === null && workspace.index.length === 0, 'Malformed folder inventory');
  invariant(!existsSync(destination), 'Folder destination already exists'); privateDir(destination); validateInventory(workspace.files);
  for (const entry of workspace.files) {
    invariant(!sensitive(entry.path), `Sensitive result path: ${entry.path}`);
    if (entry.type === 'deleted') continue;
    const full = join(destination, entry.path); mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    if (entry.type === 'symlink') symlinkSync(entry.target!, full);
    else { writeFileSync(full, blobs.get(entry.hash!), { flag: 'wx', mode: 0o600 }); chmodSync(full, entry.mode === '100755' ? 0o755 : 0o644); }
  }
  invariant(json(folderInventory(destination, blobs).files) === json(workspace.files.filter(f => f.type !== 'deleted')), 'Restored folder verification failed'); return destination;
}
