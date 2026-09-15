import { existsSync, lstatSync, readlinkSync, mkdirSync, symlinkSync, chmodSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { captureFolder, folderInventory, restoreFolder } from './folder.js';
import { Blobs } from './blobs.js';
import { Workspace, type FileEntry } from './schema.js';
import { atomicWrite, hash, invariant, json, privateDir, readBytes, run, safeLink, safePath, validatePaths } from './safe.js';

export function git(cwd: string, args: string[], input?: string | Buffer) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: tmpdir(), LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1' };
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never', ...args], { cwd, env, input });
}
const text = (b: Buffer) => b.toString('utf8').trim();
const nul = (b: Buffer) => b.toString('utf8').split('\0').filter(Boolean);
export function forbidden(path: string) { return /(^|\/)(\.ssh|auth\.json|credentials(?:\.json)?|id_(rsa|ed25519|ecdsa|dsa)(?:\.pub)?)(\/|$)/i.test(path) || /(^|\/)\.pi\/(agent\/)?(auth|sessions)(\/|\.)/i.test(path); }
export function sensitive(path: string) { return forbidden(path) || /(^|\/)(\.env(?:\..*)?|.*\.(pem|key|p12|pfx)|secrets?(?:\..*)?)(\/|$)/i.test(path); }
export function repository(cwd: string) { return realpathSync(text(git(cwd, ['rev-parse', '--show-toplevel']))); }
function preflight(root: string) {
  invariant(text(git(root, ['rev-parse', '--show-object-format'])) === 'sha1', 'Only SHA-1 Git repositories supported');
  invariant(text(git(root, ['rev-parse', '--is-shallow-repository'])) === 'false', 'Shallow repository unsupported');
  const common = resolve(root, text(git(root, ['rev-parse', '--git-common-dir'])));
  const gitdir = resolve(root, text(git(root, ['rev-parse', '--git-dir'])));
  invariant(common === gitdir || existsSync(join(common, 'bauble-owned.json')), 'Unmanaged linked worktree unsupported');
  for (const path of ['shallow', 'objects/info/alternates', 'info/sparse-checkout']) invariant(!existsSync(join(common, path)), `Unsupported Git state: ${path}`);
  for (const path of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'index.lock']) invariant(!existsSync(join(gitdir, path)), `Unresolved Git operation: ${path}`);
  const config = git(root, ['config', '--local', '--list']).toString('utf8');
  invariant(!/(^|\n)(filter\.|extensions\.partialclone|remote\..*\.promisor|core\.sparsecheckout|core\.splitindex|core\.worktree=)/i.test(config.replace(/^core\.worktree=.*\n?/gm, common !== gitdir ? '' : '$&')), 'Filter/partial/sparse/split-index repository unsupported');
  invariant(!existsSync(join(root, '.gitmodules')), 'Submodules unsupported');
  const flags = nul(git(root, ['ls-files', '-v', '-z']));
  invariant(flags.every(p => p.startsWith('H ')), 'Unmerged, assume-unchanged or skip-worktree index unsupported');
}
function indexEntries(root: string, blobs: Blobs): Workspace['index'] {
  return nul(git(root, ['ls-files', '--stage', '-z'])).map(line => {
    const match = /^(100644|100755|120000) ([a-f0-9]{40}) 0\t(.+)$/.exec(line);
    invariant(match, 'Unsupported index mode/stage/path'); const [, mode, oid, path] = match;
    safePath(path!); invariant(!forbidden(path!), `Credential/SSH path in index: ${path}`);
    const data = git(root, ['cat-file', 'blob', oid!]);
    invariant(!data.subarray(0, 100).toString().startsWith('version https://git-lfs.github.com/spec/'), `LFS pointer unsupported: ${path}`);
    return { path: path!, mode: mode as '100644' | '100755' | '120000', oid: oid!, hash: blobs.put(data) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function historyPaths(root: string): string[] {
  const trees = new Set<string>(); const paths = new Set<string>();
  for (const line of text(git(root, ['log', '--format=%T', 'HEAD'])).split('\n')) trees.add(line);
  for (const tree of trees) for (const entry of nul(git(root, ['ls-tree', '-r', '-z', tree]))) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(entry); invariant(match, 'Unsupported history path');
    const path = match[4]!; safePath(path); invariant(match[1] !== '160000', 'Submodules in history unsupported');
    invariant(!forbidden(path), `Git history contains forbidden credential/SSH path: ${path}`);
    if (sensitive(path)) paths.add(path);
  }
  return [...paths].sort();
}
export function inventory(root: string, blobs: Blobs, approveSensitive: string[] = []): Pick<Workspace, 'head' | 'index' | 'files' | 'excluded'> {
  if (!hasGit(root)) return folderInventory(root, blobs);
  preflight(root); const head = text(git(root, ['rev-parse', 'HEAD'])); const index = indexEntries(root, blobs);
  const tracked = nul(git(root, ['ls-files', '-z']));
  const untracked = nul(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const ignored = nul(git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']));
  const excluded = ignored.filter(path => !approveSensitive.includes(path)).map(path => ({ path, reason: 'Git ignored (not transferred from working tree)' }));
  const files: FileEntry[] = [];
  for (const path of [...new Set([...tracked, ...untracked, ...ignored.filter(path => approveSensitive.includes(path))])].sort()) {
    safePath(path);
    if (sensitive(path) && !approveSensitive.includes(path)) {
      invariant(!tracked.includes(path), `Tracked sensitive file requires explicit per-file inclusion: ${path}`);
      excluded.push({ path, reason: 'Likely secret (not transferred)' }); continue;
    }
    invariant(!forbidden(path), `Never transfer credential/SSH path: ${path}`);
    // No ancestor may be a symlink; never inspect through a workspace escape.
    let parent = dirname(path);
    while (parent !== '.') { try { invariant(!lstatSync(join(root, parent)).isSymbolicLink(), `Symlink ancestor: ${path}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } parent = dirname(parent); }
    const full = join(root, path); let stat;
    try { stat = lstatSync(full); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!stat) { files.push({ path, type: 'deleted', mode: index.find(p => p.path === path)?.mode ?? '100644' }); continue; }
    if (stat.isSymbolicLink()) { const target = readlinkSync(full); safeLink(path, target); files.push({ path, type: 'symlink', mode: '120000', target }); }
    else { invariant(stat.isFile(), `Special file/directory unsupported: ${path}`); files.push({ path, type: 'file', mode: stat.mode & 0o111 ? '100755' : '100644', hash: blobs.put(readBytes(full)) }); }
  }
  validateInventory(files); validatePaths(index.map(i => i.path));
  const attributes = git(root, ['check-attr', '-z', '--stdin', 'filter'], Buffer.from([...tracked, ...untracked].join('\0') + '\0')).toString().split('\0');
  for (let i = 2; i < attributes.length; i += 3) invariant(['unspecified', 'unset'].includes(attributes[i]!), `Filter-dependent path: ${attributes[i - 2]}`);
  return { head, index, files, excluded: excluded.sort((a, b) => a.path.localeCompare(b.path, 'en')) };
}
export function validateInventory(files: FileEntry[]) {
  validatePaths(files.map(f => f.path));
  for (const f of files) {
    if (f.type === 'file') invariant(f.hash && !f.target && f.mode !== '120000', `Malformed file: ${f.path}`);
    if (f.type === 'symlink') { invariant(f.target && !f.hash && f.mode === '120000', `Malformed link: ${f.path}`); safeLink(f.path, f.target); }
    if (f.type === 'deleted') invariant(!f.hash && !f.target, `Malformed deletion: ${f.path}`);
  }
  // Reject links that resolve via other links; this closes chained escape/cycle ambiguity.
  const links = files.filter(f => f.type === 'symlink').map(f => f.path);
  for (const f of files.filter(f => f.type === 'symlink')) { const destination = relative('/', resolve('/', dirname(f.path), f.target!)); invariant(!links.some(p => destination === p || destination.startsWith(p + '/')), `Chained symlink unsupported: ${f.path}`); }
}
export function hasGit(cwd: string) { let path = resolve(cwd); while (true) { if (existsSync(join(path, '.git')) || (existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects')) && existsSync(join(path, 'config')))) return true; const parent = dirname(path); if (parent === path) return false; path = parent; } }
export function captureWorkspace(cwd: string, blobs: Blobs, sensitiveApproved: string[] = [], historyApproved: string[] = []): { root: string; workspace: Workspace } {
  if (!hasGit(cwd)) { invariant(!sensitiveApproved.length && !historyApproved.length, 'Plain folders do not support sensitive/history inclusion overrides'); const root = realpathSync(cwd); return { root, workspace: captureFolder(root, blobs) }; }
  const root = repository(cwd); const before = inventory(root, blobs, sensitiveApproved);
  const historySensitive = historyPaths(root);
  for (const path of historySensitive) invariant(historyApproved.includes(path), `Git bundle includes sensitive historical bytes; explicit history inclusion required: ${path}`);
  const temporary = mkdtempSync(join(tmpdir(), 'bauble-bundle-')); let bundle: string;
  try { const path = join(temporary, 'history.bundle'); git(root, ['bundle', 'create', path, 'HEAD']); bundle = blobs.put(readBytes(path)); } finally { rmSync(temporary, { recursive: true, force: true }); }
  invariant(json(before) === json(inventory(root, blobs, sensitiveApproved)), 'Workspace changed during capture; quiesce editors/watchers and capture again');
  return { root, workspace: { ...before, bundle, historySensitive, historyApproved, sensitiveApproved } };
}
export function assertWorkspaceUnchanged(root: string, workspace: Workspace, blobs: Blobs) {
  const { head, index, files, excluded } = workspace;
  invariant(json({ head, index, files, excluded }) === json(inventory(root, blobs, workspace.sensitiveApproved)), 'Source workspace changed; fresh capture and approval required');
}
export function restoreWorkspace(workspace: Workspace, blobs: Blobs, destination: string, target?: string) {
  Workspace.parse(workspace); validateInventory(workspace.files); validatePaths(workspace.index.map(i => i.path));
  invariant(!existsSync(destination), `Destination already exists: ${destination}`); privateDir(destination);
  const worktree = target ?? join(destination, 'worktree');
  if (workspace.head === null) return restoreFolder(workspace, blobs, worktree);
  invariant(workspace.bundle, 'Missing Git bundle');
  const bare = join(destination, 'objects.git');
  git(destination, ['init', '--bare', '--template=', bare]); atomicWrite(join(bare, 'bauble-owned.json'), json({ version: 1 }));
  const bundle = join(destination, 'history.bundle'); atomicWrite(bundle, blobs.get(workspace.bundle));
  git(bare, ['bundle', 'verify', bundle]);
  git(bare, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', bundle, 'HEAD:refs/heads/bauble']);
  invariant(text(git(bare, ['rev-parse', 'refs/heads/bauble'])) === workspace.head, 'HEAD mismatch');
  git(bare, ['fsck', '--full', '--strict']);
  git(bare, ['worktree', 'add', '--no-checkout', '--detach', worktree, workspace.head]);
  for (const entry of workspace.index) {
    invariant(!forbidden(entry.path), `Forbidden index path: ${entry.path}`);
    const oid = text(git(bare, ['hash-object', '-w', '--stdin'], blobs.get(entry.hash)));
    invariant(oid === entry.oid, `Index object mismatch: ${entry.path}`);
  }
  git(worktree, ['read-tree', '--empty']);
  git(worktree, ['update-index', '-z', '--index-info'], workspace.index.map(e => `${e.mode} ${e.oid}\t${e.path}\0`).join(''));
  for (const entry of workspace.files) {
    invariant(!forbidden(entry.path), `Forbidden workspace path: ${entry.path}`);
    if (entry.type === 'deleted') continue;
    const path = join(worktree, entry.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (entry.type === 'symlink') symlinkSync(entry.target!, path);
    else { writeFileSync(path, blobs.get(entry.hash!), { flag: 'wx', mode: 0o600 }); chmodSync(path, entry.mode === '100755' ? 0o755 : 0o644); }
  }
  const restored = inventory(worktree, blobs, workspace.sensitiveApproved);
  invariant(restored.head === workspace.head && json(restored.index) === json(workspace.index) && json(restored.files) === json(workspace.files), 'Restored workspace verification failed');
  return worktree;
}
