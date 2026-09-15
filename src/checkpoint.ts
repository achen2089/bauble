import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { Store } from './store.js';
import { Id, Manifest, type Registration, type Profile } from './schema.js';
import { captureWorkspace, assertWorkspaceUnchanged, validateInventory, forbidden } from './workspace.js';
import { captureNative, validateSession } from './pi/native.js';
import type { AgentSession } from './pi/native.js';
import { atomicWrite, hash, invariant, json, readBytes, safeLink, validatePaths } from './safe.js';
import { readProfile, profileDigest } from './pi/profile.js';
export function captureCheckpoint(options: { store: Store; registration: Registration; profile: Profile; destination: string; targetRoot: string; instruction?: string; live?: AgentSession; sensitive?: string[]; history?: string[]; transferId?: string }) {
  const { store, registration: reg } = options; const transferId = Id.parse(options.transferId ?? randomUUID());
  invariant(!existsSync(join(store.transfer(transferId), 'manifest.json')), 'Capture ID already published; reconcile the existing checkpoint');
  const owner = store.owner(reg.lineageId); invariant(owner.state === 'frozen' && owner.generation === reg.generation, 'Source must be frozen before capture');
  const { root, workspace } = captureWorkspace(reg.cwd, store.blobs, options.sensitive, options.history);
  const native = captureNative(reg, options.profile, store.blobs, options.live);
  const targetRepo = join(options.targetRoot, 'runs', transferId, 'workspace', 'worktree');
  const refs = [...new Set([...(workspace.bundle ? [workspace.bundle] : []), ...workspace.index.map(i => i.hash), ...workspace.files.flatMap(i => i.hash ? [i.hash] : []), native.session, ...native.resources.map(r => r.hash), ...native.artifacts.map(a => a.hash)])].sort();
  const manifest: Manifest = { protocol: 1, transferId, lineageId: reg.lineageId, parentTransfer: reg.parentTransfer, generation: reg.generation + 1, created: new Date().toISOString(), agent: 'pi', piVersion: '0.85.1', destination: options.destination, source: { repository: root, cwd: reg.cwd }, target: { repository: targetRepo, cwd: join(targetRepo, relative(root, realpathSync(reg.cwd))) }, instruction: options.instruction ?? null, workspace, native, blobs: refs.map(hash => ({ hash, size: store.blobs.get(hash).length })) };
  const digest = store.putManifest(manifest);
  store.lock(reg.lineageId, () => {
    const current = store.owner(reg.lineageId);
    invariant(current.state === 'frozen' && current.generation === reg.generation && current.transferId === owner.transferId && current.digest === owner.digest, 'Source ownership changed during capture');
    store.setOwner({ ...current, transferId, digest });
  });
  const checkpoint = store.transfer(transferId);
  atomicWrite(join(checkpoint, 'agent-state', 'session.jsonl'), store.blobs.get(native.session));
  atomicWrite(join(checkpoint, 'agent-state', 'metadata.json'), json(native));
  atomicWrite(join(checkpoint, 'workspace', 'inventory.json'), json(workspace));
  if (workspace.bundle) atomicWrite(join(checkpoint, 'workspace', 'history.bundle'), store.blobs.get(workspace.bundle));
  for (const ref of refs) atomicWrite(join(checkpoint, 'blobs', ref), store.blobs.get(ref));
  return { manifest, digest, checkpoint };
}
export function captureOffline(options: Omit<Parameters<typeof captureCheckpoint>[0], 'profile' | 'live'>) {
  const { store, registration: reg } = options;
  invariant(reg.cleanShutdown, 'Session has no verified clean shutdown; do not infer shutdown from a missing process/socket');
  const transferId = options.transferId ?? randomUUID();
  const before = store.lock(reg.lineageId, () => {
    const owner = store.owner(reg.lineageId);
    invariant(owner.state === 'owned' && owner.generation === reg.generation, 'Remote source not owner at registration generation');
    store.setOwner({ ...owner, state: 'frozen' }); return owner;
  });
  try { return captureCheckpoint({ ...options, transferId, profile: readProfile(reg.profilePath) }); }
  catch (error) {
    // A published checkpoint or a changed binding must retain its freeze for recovery.
    store.lock(reg.lineageId, () => {
      const owner = store.owner(reg.lineageId);
      if (!existsSync(join(store.transfer(transferId), 'manifest.json')) && json(owner) === json({ ...before, state: 'frozen' })) store.setOwner(before);
    });
    throw error;
  }
}
export function approvalText(manifest: Manifest, digest: string) {
  return json({ name: manifest.name, codeRoot: manifest.codeRoot, inputs: manifest.inputs, effectiveProfile: manifest.native.profile, runtimeExclusions: 'No ambient resources, extensions, settings, credentials copied; documents are literal input, never hooks. Native tools retain OS user permissions; this is not a sandbox.', warning: manifest.native.session === null ? 'TRUST DESTINATION. Fresh native Pi task; no source transcript/session. Approved workspace and literal task/context will be transferred and run. Git mode includes HEAD reachable history. Idle is not success.' : 'TRUST DESTINATION. Exact Git HEAD reachable history and full native transcript (all branches, attachments, outputs) are included and may contain secrets. Quiesce editors/watchers. Exclusions apply only to working-tree bytes, not Git history or transcript. Idle is not success.', approvalDigest: digest, destination: manifest.destination, source: manifest.source, target: manifest.target, includedFiles: manifest.workspace.files, index: manifest.workspace.index, exclusions: manifest.workspace.excluded, historySensitiveIncluded: manifest.workspace.historySensitive, historyExplicitApprovals: manifest.workspace.historyApproved, resources: manifest.native.resources, artifacts: manifest.native.artifacts, requirements: manifest.native.requirements, exactContinuation: manifest.instruction, blobInventory: manifest.blobs });
}
export function verifySource(store: Store, id: string) {
  const { manifest } = store.verify(id); invariant(manifest.native.sessionId, 'Fresh task has no source session'); const reg = store.registration(manifest.native.sessionId);
  invariant(hash(readBytes(reg.sessionFile)) === manifest.native.session && reg.leaf === manifest.native.leaf, 'Native source changed; capture and approve again');
  assertWorkspaceUnchanged(manifest.source.repository, manifest.workspace, store.blobs);
}
export function validateCheckpoint(store: Store, id: string) {
  const { manifest } = store.verify(id);
  validatePaths((manifest.inputs ?? []).map(i => i.path));
  for (const input of manifest.inputs ?? []) invariant(!forbidden(input.path) && !forbidden(input.source), 'Forbidden task/context path');
  validateInventory(manifest.workspace.files); validatePaths(manifest.workspace.index.map(e => e.path));
  for (const entry of manifest.workspace.index) { invariant(!forbidden(entry.path), 'Forbidden credential/SSH index path'); if (entry.mode === '120000') safeLink(entry.path, store.blobs.get(entry.hash).toString('utf8')); }
  for (const entry of manifest.workspace.files) invariant(!forbidden(entry.path), 'Forbidden credential/SSH workspace path');
  if (manifest.native.session !== null) validateSession(store.blobs.get(manifest.native.session), manifest.native.leaf!, manifest.native.profile.testOnly);
  else invariant(manifest.parentTransfer === null && manifest.generation === 1 && manifest.instruction !== null, 'Malformed fresh job');
  invariant((manifest.workspace.head === null) === (manifest.workspace.bundle === null), 'Workspace kind mismatch');
  if (manifest.workspace.head === null) invariant(!manifest.workspace.index.length, 'Folder has Git index');
  invariant(profileDigest(manifest.native.profile, manifest.native.resources) === manifest.native.profileDigest, 'Profile inventory binding mismatch');
  const repo = resolve(manifest.target.repository); invariant(resolve(manifest.target.cwd) === repo || resolve(manifest.target.cwd).startsWith(repo + '/'), 'Target cwd outside repository');
  return manifest;
}
