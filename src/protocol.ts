import type { OperationContext } from './output.js';
import { CliError, withStreamCapability } from './errors.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { Digest, Id, Restoration, Status } from './schema.js';
import { atomicWrite, hash, invariant, json, privateDir, readBytes, readJson, run, syncTree, withAsyncLock } from './safe.js';
import { validateCheckpoint, verifySource } from './checkpoint.js';
import { CHUNK, control, type Rpc } from './transport.js';
import { readProfile, snapshotProfile, materializeProfile } from './pi/profile.js';
import { inventory, restoreWorkspace } from './workspace.js';
import { prepareFresh } from './fresh.js';
import { restoreNative } from './pi/native.js';
import { processMatches } from './process.js';
export async function stage(store: Store, id: string, rpc: Rpc, root: string, context: OperationContext = {}) {
  const { manifest, digest } = store.approved(id); context.progress?.('verify'); store.verify(id);
  context.progress?.('upload');
  const response = z.object({ missing: z.array(Digest), digest: Digest }).parse(await rpc({ operation: 'manifest', root, data: { manifest, digest } })); invariant(response.digest === digest, 'Destination manifest acknowledgment mismatch');
  for (const digest of response.missing) { invariant(manifest.blobs.some(b => b.hash === digest), 'Destination requested unapproved blob'); const bytes = store.blobs.get(digest);
    for (let offset = 0; offset < bytes.length || (offset === 0 && bytes.length === 0); offset += CHUNK) await rpc({ operation: 'blob', root, data: { id, digest, offset, size: bytes.length, bytes: bytes.subarray(offset, offset + CHUNK).toString('base64') } });
  }
  context.progress?.('readiness');
  const ready = z.object({ digest: Digest, ready: z.literal(true) }).parse(await rpc({ operation: 'ready', root, data: { id, digest } })); invariant(ready.digest === digest, 'Ready acknowledgment mismatch'); return ready;
}
export async function sendCheckpoint(store: Store, id: string, rpc: Rpc, root: string, context: OperationContext = {}) {
  const { manifest } = store.approved(id);
  const alreadyFenced = store.lock(manifest.lineageId, () => {
    const state = store.owner(manifest.lineageId).state;
    invariant(state === 'frozen' || state === 'fenced', 'Source no longer frozen/fenced for send');
    assertSourceBinding(store, id, state); return state === 'fenced';
  });
  if (alreadyFenced) return reconcileFenced(store, id, rpc, root, true);
  await stage(store, id, rpc, root, context);
  verifySource(store, id); store.fence(id);
  return reconcileFenced(store, id, rpc, root);
}
function assertSourceBinding(store: Store, id: string, state: 'frozen' | 'fenced') {
  const { manifest, digest } = store.approved(id); const owner = store.owner(manifest.lineageId);
  invariant(owner.state === state && owner.transferId === id && owner.digest === digest && owner.generation === manifest.generation - (state === 'frozen' ? 1 : 0), 'Source ownership does not match this transfer/digest/generation');
}
function recordRemoteStatus(store: Store, id: string, status: Status) {
  const { manifest, digest } = store.approved(id);
  invariant(status.transferId === id && status.digest === digest && status.phase !== 'cancelled', 'Remote status binding mismatch or revoked transfer');
  if (status.receipt) {
    const receipt = status.receipt;
    invariant(receipt.digest === digest && receipt.lineageId === manifest.lineageId && receipt.generation === manifest.generation && receipt.transferId === id, 'Readiness receipt mismatch');
    store.update(id, { phase: 'active', ownership: 'fenced', execution: status.execution, receipt });
  } else store.update(id, { phase: 'unknown', ownership: 'fenced', execution: 'unknown' });
  return store.status(id);
}
async function reconcileFenced(store: Store, id: string, rpc: Rpc, root: string, query = false) {
  const { manifest, digest } = store.approved(id);
  // Serialize authority with local cancellation and return finalization, including the RPC.
  return withAsyncLock(join(store.root, 'locks', manifest.lineageId), async () => {
    assertSourceBinding(store, id, 'fenced');
    if (query) {
      let observation: unknown;
      try { observation = await rpc({ operation: 'status', root, data: { id, digest } }); } catch (error) { throw withStreamCapability(error, new CliError('AUTHORITY_UNCERTAIN', 'The fenced transfer could not be reconciled.', 'uncertain', 'Recover the same ID; never recapture.', { transferId: id, digest })); }
      const status = Status.parse(observation);
      invariant(status.transferId === id && status.digest === digest, 'Remote status binding mismatch');
      if (status.receipt || status.phase !== 'ready') return recordRemoteStatus(store, id, status);
    }
    try {
      const status = Status.parse(await rpc({ operation: 'activate', root, data: { id, digest } }));
      return recordRemoteStatus(store, id, status);
    } catch (e) { store.update(id, { phase: 'unknown', ownership: 'fenced', execution: 'unknown', error: String(e) }); throw withStreamCapability(e, new CliError('AUTHORITY_UNCERTAIN', 'Source is fenced; activation acknowledgment was lost.', 'uncertain', 'Recover the existing ID; never recapture.', { transferId: id, digest })); }
  });
}
export async function recoverOutbound(store: Store, id: string, rpc: Rpc, root: string, context: OperationContext = {}) {
  const { manifest } = store.approved(id); // Reject cancellation before *any* authority RPC.
  const state = store.lock(manifest.lineageId, () => {
    const owner = store.owner(manifest.lineageId);
    invariant(owner.state === 'frozen' || owner.state === 'fenced', 'Source no longer frozen/fenced for recovery');
    assertSourceBinding(store, id, owner.state); return owner.state;
  });
  // The remote may not have received even the manifest. Never infer absence from an SSH failure.
  if (state === 'frozen') return sendCheckpoint(store, id, rpc, root, context);
  return reconcileFenced(store, id, rpc, root, true);
}
export async function cancelTransfer(store: Store, id: string, rpc: Rpc, root: string) {
  const { manifest, digest } = store.manifest(id);
  // Always seek positive revocation; safe even if activation authority was issued but its acknowledgment was lost.
  const revoked = z.object({ revoked: z.literal(true), transferId: Id, digest: Digest }).parse(await rpc({ operation: 'revoke', root, data: { id, digest } }));
  invariant(revoked.transferId === id && revoked.digest === digest, 'Revocation mismatch');
  store.lock(manifest.lineageId, () => {
    const owner = store.owner(manifest.lineageId);
    invariant(owner.transferId === id && owner.digest === digest && ((owner.state === 'fenced' && owner.generation === manifest.generation) || (owner.state === 'frozen' && owner.generation + 1 === manifest.generation)), 'Source no longer eligible for cancellation of this transfer');
    store.update(id, { phase: 'cancelled', ownership: 'source', execution: 'unknown' });
    store.setOwner({ ...owner, state: 'owned' });
  });
  invariant(manifest.native.sessionId, 'Fresh task has no source session'); const reg = store.registration(manifest.native.sessionId);
  store.register({ ...reg, generation: store.owner(manifest.lineageId).generation });
  if (!reg.cleanShutdown && processMatches(reg)) await control(reg.socket, { operation: 'finish', id });
}
export { handleRequest, type HelperOptions } from './helper.js';
export function prepareRestore(store: Store, id: string) {
  return store.lock(id, () => {
    const manifest = validateCheckpoint(store, id); invariant(manifest.native.session !== null, 'Use fresh preparation for new tasks'); const { digest } = store.manifest(id);
    const root = join(store.root, 'runs', id); const receiptPath = join(root, 'restoration.json');
    if (existsSync(receiptPath)) {
      const receipt = readJson(receiptPath, Restoration); const restored = receipt.restored;
      invariant(receipt.transferId === id && receipt.digest === digest, 'Restoration receipt binding mismatch');
      invariant(restored.cwd === manifest.target.cwd && restored.profilePath === join(root, 'profile.json') && resolve(restored.sessionFile).startsWith(join(root, 'native', 'sessions') + '/'), 'Restoration receipt path mismatch');
      invariant(json(restored) === readBytes(join(root, 'restored.json')).toString(), 'Restoration metadata changed');
      invariant(hash(readBytes(restored.sessionFile)) === receipt.sessionHash && hash(readBytes(restored.profilePath)) === receipt.profileHash, 'Restored native session/profile changed');
      invariant(snapshotProfile(readProfile(restored.profilePath), root, store.blobs).digest === manifest.native.profileDigest, 'Restored resources changed');
      invariant(hash(readBytes(join(root, 'native', 'source.jsonl'))) === manifest.native.session, 'Restored native archive changed');
      for (const artifact of manifest.native.artifacts) invariant(hash(readBytes(join(root, 'native', 'artifacts', artifact.hash))) === artifact.hash, 'Restored artifact changed');
      const actual = inventory(manifest.target.repository, store.blobs, manifest.workspace.sensitiveApproved);
      invariant(actual.head === manifest.workspace.head && json(actual.index) === json(manifest.workspace.index) && json(actual.files) === json(manifest.workspace.files), 'Restored workspace changed');
      return restored;
    }
    // Never delete/rebuild partial roots: absence of a completion receipt is not proof of safety.
    invariant(!existsSync(root), 'Partial restoration without durable receipt; manual inspection required'); privateDir(root);
    const workspace = restoreWorkspace(manifest.workspace, store.blobs, join(root, 'workspace'));
    invariant(workspace === manifest.target.repository, 'Restoration target mismatch');
    const cwd = resolve(manifest.target.cwd); invariant(existsSync(cwd), 'Target cwd missing from approved inventory');
    const native = restoreNative({ ...manifest.native, sessionId: manifest.native.sessionId!, leaf: manifest.native.leaf!, session: manifest.native.session!, runtimeSignature: manifest.native.runtimeSignature! }, store.blobs, cwd, join(root, 'native'), id);
    const profile = materializeProfile(manifest.native.profile, manifest.native.resources, store.blobs, join(root, 'resources'));
    const profilePath = join(root, 'profile.json'); atomicWrite(profilePath, json(profile));
    const restored = { sessionId: native.manager.getSessionId(), sessionFile: native.file, leaf: native.restoredLeaf, cwd, profilePath };
    atomicWrite(join(root, 'restored.json'), json(restored));
    syncTree(root); // The completion receipt must never precede durable materialization.
    atomicWrite(receiptPath, json({ transferId: id, digest, restored, sessionHash: hash(readBytes(native.file)), profileHash: hash(readBytes(profilePath)) }));
    return restored;
  });
}
export async function launchTmux(store: Store, id: string) {
  const manifest = store.manifest(id).manifest; const token = `b${id.replaceAll('-', '')}`;
  if (manifest.native.session === null) prepareFresh(store, id); else prepareRestore(store, id);
  // Multiple command arguments instruct tmux to exec argv directly, not a shell command string.
  run('tmux', ['-L', token, '-f', '/dev/null', 'new-session', '-d', '-s', token, 'bauble', '_runtime', id, '--root', store.root]);
  // Readiness is a durable native receipt, never process presence or screen scraping.
  for (let attempt = 0; attempt < 100; attempt++) { const status = store.status(id); if (status.receipt) return; if (status.execution === 'failed') throw new Error(status.error); await new Promise(ok => setTimeout(ok, 100)); }
  store.update(id, { phase: 'unknown', execution: 'unknown', error: 'No native readiness receipt; reconcile same transfer ID; never restart automatically' });
}
