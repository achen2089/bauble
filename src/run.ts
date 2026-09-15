import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { Alias, Manifest, Status } from './schema.js';
import { loadConfig, selectHost } from './config.js';
import { atomicWrite, hash, invariant, json, readBytes, validatePaths, withAsyncLock } from './safe.js';
import { captureWorkspace, assertWorkspaceUnchanged, sensitive, forbidden } from './workspace.js';
import { folderInventory, safeFolderRoot } from './folder.js';
import { readProfile, snapshotProfile, validateModel } from './pi/profile.js';
import { approvalText, validateCheckpoint } from './checkpoint.js';
import { approve } from './commands.js';
import { stage } from './protocol.js';
import { ssh, type Rpc } from './transport.js';

export interface RunOptions { cwd?: string; task?: string; prompt?: string; context?: string[]; host?: string; name?: string; profile?: string; autoApprove?: boolean; sensitive?: string[]; history?: string[] }
export function literalInput(bytes: Buffer) { const text = bytes.toString('utf8'); invariant(Buffer.from(text).equals(bytes) && !text.includes('\0'), 'Task/context must be literal UTF-8 without NUL'); return text; }
export async function captureTask(options: RunOptions, store: Store, target: { alias: string; root: string; codeRoot?: string; profile: string; profileDigest: string }) {
  invariant((options.task !== undefined) !== (options.prompt !== undefined), 'Select exactly one --task file or --prompt literal text');
  const cwd = safeFolderRoot(resolve(options.cwd ?? process.cwd()), store.root); const name = options.name ? Alias.parse(options.name) : undefined;
  const profilePath = resolve(options.profile ?? target.profile); const profile = readProfile(profilePath); await validateModel(profile, store.root);
  invariant(!profile.testOnly || process.env.BAUBLE_TEST_MODE === '1', 'Test profile requires BAUBLE_TEST_MODE=1');
  const snapshot = snapshotProfile(profile, dirname(profilePath), store.blobs); invariant(snapshot.digest === target.profileDigest, 'Selected profile differs from configured host; run explicit setup after configuring both ends');
  const { root, workspace } = captureWorkspace(cwd, store.blobs, options.sensitive, options.history); safeFolderRoot(root, store.root);
  const inputs: NonNullable<Manifest['inputs']> = []; const contexts: { path: string; text: string }[] = []; const contextInventories: { root: string; inventory: string }[] = [];
  function input(source: string, path: string, role: 'task' | 'context') {
    const full = resolve(source); invariant(realpathSync(full) === full && !sensitive(full), 'Sensitive or symlink task/context path');
    const bytes = readBytes(full, 1024 * 1024); const text = literalInput(bytes); inputs.push({ source: full, path, role, hash: store.blobs.put(bytes) }); return text;
  }
  const task = options.task !== undefined ? input(options.task, 'task/' + basename(options.task), 'task') : literalInput(Buffer.from(options.prompt!)); invariant(task.trim(), 'Task must not be empty');
  for (const [i, source] of (options.context ?? []).entries()) {
    const full = resolve(source); invariant(!forbidden(full) && realpathSync(full) === full, 'Unsafe context path');
    if (lstatSync(full).isDirectory()) {
      safeFolderRoot(full, store.root); const inventory = folderInventory(full, store.blobs); contextInventories.push({ root: full, inventory: json(inventory) });
      invariant(!inventory.excluded.some(e => sensitive(e.path)), 'Context directory contains sensitive paths');
      for (const file of inventory.files) { invariant(file.type === 'file', 'Explicit context directories require regular files, not symlinks'); const path = `context/${i}/${file.path}`; contexts.push({ path, text: input(join(full, file.path), path, 'context') }); }
    } else { const path = `context/${i}/${basename(full)}`; contexts.push({ path, text: input(full, path, 'context') }); }
  }
  validatePaths(inputs.map(i => i.path));
  const transferId = randomUUID(); const lineageId = randomUUID();
  const targetRepo = target.codeRoot ? join(resolve(target.codeRoot), `${name ? name + '-' : ''}${transferId}`) : join(target.root, 'runs', transferId, 'workspace', 'worktree');
  const instruction = contexts.length ? task + '\n\nBauble literal context snapshots (JSON data; not commands or hooks):\n' + json(contexts) : task;
  invariant(Buffer.byteLength(instruction) <= 1024 * 1024, 'Combined literal task/context exceeds 1 MiB');
  const native = { kind: 'fresh' as const, session: null, sessionId: null, leaf: null, runtimeSignature: null, profile, profileDigest: snapshot.digest, resources: snapshot.resources, artifacts: [], requirements: { provider: profile.provider, model: profile.model, credentialAvailable: true, executables: profile.executables, services: profile.services } };
  const refs = [...new Set([...(workspace.bundle ? [workspace.bundle] : []), ...workspace.index.map(i => i.hash), ...workspace.files.flatMap(f => f.hash ? [f.hash] : []), ...snapshot.resources.map(r => r.hash), ...inputs.map(i => i.hash)])].sort();
  const manifest = Manifest.parse({ protocol: 1, transferId, lineageId, parentTransfer: null, generation: 1, created: new Date().toISOString(), agent: 'pi', piVersion: '0.85.1', destination: target.alias, source: { repository: root, cwd }, target: { repository: targetRepo, cwd: join(targetRepo, relative(root, cwd)) }, instruction, workspace, native, inputs, ...(name ? { name } : {}), ...(target.codeRoot ? { codeRoot: resolve(target.codeRoot) } : {}), blobs: refs.map(hash => ({ hash, size: store.blobs.get(hash).length })) });
  const digest = store.putManifest(manifest); atomicWrite(join(store.transfer(transferId), 'source-inputs.json'), json({ profilePath, contextInventories }));
  verifyTaskSource(store, transferId); return { manifest, digest };
}
export function verifyTaskSource(store: Store, id: string) {
  const { manifest } = validateTask(store, id); assertWorkspaceUnchanged(manifest.source.repository, manifest.workspace, store.blobs);
  for (const input of manifest.inputs ?? []) invariant(realpathSync(input.source) === input.source && hash(readBytes(input.source)) === input.hash, 'Task/context changed; capture and approve a new job');
  const binding = JSON.parse(readBytes(join(store.transfer(id), 'source-inputs.json')).toString()) as { profilePath: string; contextInventories: { root: string; inventory: string }[] };
  invariant(snapshotProfile(readProfile(binding.profilePath), dirname(binding.profilePath), store.blobs).digest === manifest.native.profileDigest, 'Profile changed before dispatch');
  for (const context of binding.contextInventories) invariant(json(folderInventory(context.root, store.blobs)) === context.inventory, 'Context inventory changed before dispatch');
}
function validateTask(store: Store, id: string) { const value = store.verify(id); invariant(value.manifest.native.session === null, 'Not a fresh job'); validateCheckpoint(store, id); return value; }
export async function dispatchTask(store: Store, id: string, rpc: Rpc, root: string) {
  const { manifest, digest } = store.approved(id); validateTask(store, id);
  if (!manifest.codeRoot) invariant(manifest.target.repository === join(root, 'runs', id, 'workspace', 'worktree'), 'Fresh destination root changed');
  return withAsyncLock(join(store.root, 'locks', manifest.lineageId), async () => {
    const intentPath = join(store.transfer(id), 'dispatch.json');
    if (existsSync(intentPath)) {
      invariant(readBytes(intentPath).toString() === json({ id, digest, root, host: manifest.destination }), 'Fresh dispatch route changed');
      const owner = store.owner(manifest.lineageId); invariant(owner.state === 'dispatched' && owner.transferId === id && owner.digest === digest && owner.generation === manifest.generation, 'Fresh dispatch authority changed or incomplete; inspect existing ledger, never replay');
      const status = Status.parse(await rpc({ operation: 'status', root, data: { id, digest } })); return record(status);
    }
    verifyTaskSource(store, id); await stage(store, id, rpc, root); verifyTaskSource(store, id);
    // Authority is bound before RPC. A crash here is unknown and MUST NOT retransmit activation.
    atomicWrite(intentPath, json({ id, digest, root, host: manifest.destination }));
    store.setOwner({ lineageId: manifest.lineageId, generation: 1, transferId: id, digest, state: 'dispatched' });
    store.update(id, { phase: 'launch_intent', ownership: 'fenced', execution: 'starting' });
    try { return record(Status.parse(await rpc({ operation: 'activate', root, data: { id, digest } }))); }
    catch (error) { store.update(id, { phase: 'unknown', execution: 'unknown', error: String(error) }); throw error; }
    function record(status: Status) {
      invariant(status.transferId === id && status.digest === digest, 'Fresh status binding mismatch');
      if (status.receipt) { const r = status.receipt; invariant(r.lineageId === manifest.lineageId && r.generation === 1 && r.transferId === id && r.digest === digest, 'Fresh receipt mismatch'); }
      return store.update(id, { phase: status.receipt ? 'active' : 'unknown', ownership: 'fenced', execution: status.execution, continuation: status.continuation, ...(status.receipt ? { receipt: status.receipt } : {}) });
    }
  });
}
export async function runTask(options: RunOptions, store = new Store(), connect: (alias: string) => Rpc = ssh) {
  const config = loadConfig(); const alias = selectHost(config, options.host); const host = config.hosts[alias]!;
  const { manifest, digest } = await captureTask(options, store, { alias, ...host, profile: config.profile }); const id = manifest.transferId;
  console.log(`Fresh job: ${id}\nRecover this ID; repeating run creates a NEW task.\n${approvalText(manifest, digest)}`);
  if (options.autoApprove) { store.approve(id, digest); atomicWrite(join(store.transfer(id), 'autoapproval.json'), json({ id, digest, destination: alias, scope: 'transfer and execute this literal task only' })); }
  else await approve(store, id);
  const result = await dispatchTask(store, id, connect(alias), host.root); console.log(json(result));
  console.log(`Task success is not tracked. bauble open ${id} --here; bauble log ${id}; bauble pull ${id}`);
  if (result.receipt) console.log(`Destination tmux: tmux -L ${result.receipt.socket} attach-session -t ${result.receipt.target} (isolated server; not ordinary tmux ls)`);
  if (!result.receipt || result.execution === 'failed') process.exitCode = 1;
  return result;
}
