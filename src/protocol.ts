import { z } from 'zod';
import { existsSync, closeSync, fsyncSync, openSync, writeSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Digest, Id, Manifest, Restoration, Status, type Config } from './schema.js';
import { atomicWrite, hash, invariant, json, privateDir, readBytes, readJson, run, syncTree, withAsyncLock } from './safe.js';
import { validateCheckpoint, verifySource, captureOffline } from './checkpoint.js';
import { CHUNK, control, type Rpc, type Request } from './transport.js';
import { readProfile, snapshotProfile, materializeProfile, checkRequirements } from './pi/profile.js';
import { inventory, restoreWorkspace } from './workspace.js';
import { restoreNative } from './pi/native.js';
import { processMatches } from './pi/runtime.js';
import { verifyLocalAttachment } from './attachment.js';
import { Receipt } from './schema.js';
import { checkMessageRuntime, deliverMessageLocal, messageStatusLocal } from './message.js';
export async function stage(store: Store, id: string, rpc: Rpc, root: string) {
  const { manifest, digest } = store.approved(id); store.verify(id);
  const response = z.object({ missing: z.array(Digest), digest: Digest }).parse(await rpc({ operation: 'manifest', root, data: { manifest, digest } })); invariant(response.digest === digest, 'Destination manifest acknowledgment mismatch');
  for (const digest of response.missing) { invariant(manifest.blobs.some(b => b.hash === digest), 'Destination requested unapproved blob'); const bytes = store.blobs.get(digest);
    for (let offset = 0; offset < bytes.length || (offset === 0 && bytes.length === 0); offset += CHUNK) await rpc({ operation: 'blob', root, data: { id, digest, offset, size: bytes.length, bytes: bytes.subarray(offset, offset + CHUNK).toString('base64') } });
  }
  const ready = z.object({ digest: Digest, ready: z.literal(true) }).parse(await rpc({ operation: 'ready', root, data: { id, digest } })); invariant(ready.digest === digest, 'Ready acknowledgment mismatch'); return ready;
}
export async function sendCheckpoint(store: Store, id: string, rpc: Rpc, root: string) {
  const { manifest } = store.approved(id);
  const alreadyFenced = store.lock(manifest.lineageId, () => {
    const state = store.owner(manifest.lineageId).state;
    invariant(state === 'frozen' || state === 'fenced', 'Source no longer frozen/fenced for send');
    assertSourceBinding(store, id, state); return state === 'fenced';
  });
  if (alreadyFenced) return reconcileFenced(store, id, rpc, root, true);
  await stage(store, id, rpc, root);
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
      const status = Status.parse(await rpc({ operation: 'status', root, data: { id, digest } }));
      invariant(status.transferId === id && status.digest === digest, 'Remote status binding mismatch');
      if (status.receipt || status.phase !== 'ready') return recordRemoteStatus(store, id, status);
    }
    try {
      const status = Status.parse(await rpc({ operation: 'activate', root, data: { id, digest } }));
      return recordRemoteStatus(store, id, status);
    } catch (e) { store.update(id, { phase: 'unknown', ownership: 'fenced', execution: 'unknown', error: String(e) }); throw e; }
  });
}
export async function recoverOutbound(store: Store, id: string, rpc: Rpc, root: string) {
  const { manifest } = store.approved(id); // Reject cancellation before *any* authority RPC.
  const state = store.lock(manifest.lineageId, () => {
    const owner = store.owner(manifest.lineageId);
    invariant(owner.state === 'frozen' || owner.state === 'fenced', 'Source no longer frozen/fenced for recovery');
    assertSourceBinding(store, id, owner.state); return owner.state;
  });
  // The remote may not have received even the manifest. Never infer absence from an SSH failure.
  if (state === 'frozen') return sendCheckpoint(store, id, rpc, root);
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
  const reg = store.registration(manifest.native.sessionId);
  store.register({ ...reg, generation: store.owner(manifest.lineageId).generation });
  if (processMatches(reg)) await control(reg.socket, { operation: 'finish', id });
}
function bound(store: Store, data: unknown) { const value = z.object({ id: Id, digest: Digest }).strict().parse(data); invariant(store.manifest(value.id).digest === value.digest, 'Manifest binding mismatch'); return value; }
export interface HelperOptions { config: Config; allowFixture?: boolean; launch?: (store: Store, id: string) => Promise<void> }
export async function handleRequest(request: Request, options: HelperOptions): Promise<unknown> {
  const root = resolve(request.root); const configured = resolve(options.config.remoteRoot);
  const fixture = options.allowFixture && root.startsWith(join(configured, 'fixtures') + '/') && Id.safeParse(root.slice(join(configured, 'fixtures').length + 1)).success;
  invariant(root === configured || fixture, 'Remote root must match configured storage or an explicitly authorized UUID fixture');
  const store = new Store(root);
  switch (request.operation) {
    case 'probe': {
      invariant(process.platform === 'linux', 'Remote host must be Linux');
      const node = process.versions.node.split('.').map(Number); invariant(node[0]! > 22 || (node[0] === 22 && node[1]! >= 19), 'Node >=22.19.0 required');
      run('git', ['--version']); const tmux = run('tmux', ['-V']).toString(); const match = /tmux (\d+)\.(\d+)/.exec(tmux); invariant(match && (+match[1]! > 3 || (+match[1]! === 3 && +match[2]! >= 2)), 'tmux >=3.2 required');
      const profile = readProfile(options.config.profile); await checkRequirements(profile);
      return { protocol: 1, version: '0.1.0', piVersion: '0.85.1', node: process.versions.node, tmux: tmux.trim(), root, profileDigest: snapshotProfile(profile, dirname(options.config.profile), store.blobs).digest };
    }
    case 'manifest': {
      const data = z.object({ manifest: Manifest, digest: Digest }).strict().parse(request.data);
      invariant(hash(json(data.manifest)) === data.digest, 'Corrupt manifest');
      invariant(data.manifest.native.profile.testOnly ? fixture : true, 'Test profile forbidden outside isolated fixture root');
      const expected = join(root, 'runs', data.manifest.transferId, 'workspace', 'worktree'); invariant(data.manifest.target.repository === expected, 'Target path not Bauble-owned transfer root');
      const digest = store.putManifest(data.manifest, 'staging'); return { digest, missing: data.manifest.blobs.filter(b => !store.blobs.has(b.hash)).map(b => b.hash) };
    }
    case 'blob': {
      const data = z.object({ id: Id, digest: Digest, offset: z.number().int().nonnegative(), size: z.number().int().min(0).max(64 * 1024 * 1024), bytes: z.string().max(CHUNK * 2) }).strict().parse(request.data);
      const manifest = store.manifest(data.id).manifest; invariant(manifest.blobs.some(b => b.hash === data.digest && b.size === data.size), 'Blob not in immutable inventory');
      if (store.blobs.has(data.digest)) return { complete: true };
      const bytes = Buffer.from(data.bytes, 'base64'); invariant(bytes.toString('base64') === data.bytes && bytes.length <= CHUNK && data.offset + bytes.length <= data.size, 'Invalid chunk');
      return store.lock(data.id, () => { const part = join(store.transfer(data.id), `${data.digest}.part`);
        if (data.offset === 0) atomicWrite(part, Buffer.alloc(0));
        invariant(existsSync(part) && statSync(part).size === data.offset, 'Partial chunk offset mismatch; retry from complete verified blobs');
        const fd = openSync(part, 'a', 0o600); try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        if (data.offset + bytes.length === data.size) { const full = readBytes(part); invariant(hash(full) === data.digest, 'Corrupt assembled blob'); store.blobs.put(full); unlinkSync(part); return { complete: true }; }
        return { complete: false };
      });
    }
    case 'ready': {
      const { id, digest } = bound(store, request.data); const manifest = validateCheckpoint(store, id);
      if (!manifest.native.profile.testOnly) { const profile = readProfile(options.config.profile); invariant(snapshotProfile(profile, dirname(options.config.profile), store.blobs).digest === manifest.native.profileDigest, 'Destination profile mismatch'); await checkRequirements(profile); }
      invariant(store.status(id).phase !== 'cancelled', 'Transfer revoked');
      if (store.status(id).phase === 'staging') store.update(id, { phase: 'ready' });
      return { ready: true, digest };
    }
    case 'activate': {
      const { id } = bound(store, request.data);
      if (store.claim(id)) {
        try { await (options.launch ?? launchTmux)(store, id); }
        catch (e) { store.update(id, { phase: 'unknown', execution: 'unknown', error: String(e) }); throw e; }
      }
      return store.status(id);
    }
    case 'status': { const { id } = bound(store, request.data); return store.status(id); }
    case 'revoke': { const { id } = bound(store, request.data); return store.revoke(id); }
    case 'attach': {
      const { id } = bound(store, request.data); return verifyLocalAttachment(store, id);
    }
    case 'message-check': { const data = z.object({ receipt: Receipt }).strict().parse(request.data); return checkMessageRuntime(store, data.receipt); }
    case 'message': return deliverMessageLocal(store, request.data);
    case 'message-status': return messageStatusLocal(store, request.data);
    case 'log': { const { id } = bound(store, request.data); const path = join(store.transfer(id), 'run.log'); return { text: existsSync(path) ? readBytes(path).toString().slice(-256 * 1024) : '' }; }
    case 'download': { const data = z.object({ id: Id, digest: Digest, offset: z.number().int().nonnegative() }).strict().parse(request.data); const manifest = store.manifest(data.id).manifest; invariant(manifest.blobs.some(b => b.hash === data.digest), 'Unapproved download'); return { bytes: store.blobs.get(data.digest).subarray(data.offset, data.offset + CHUNK).toString('base64') }; }
    case 'capture': {
      const data = z.object({ id: Id, digest: Digest, targetRoot: z.string(), destination: z.literal('local'), returnId: Id.optional() }).strict().parse(request.data);
      const original = store.manifest(data.id); invariant(original.digest === data.digest, 'Capture binding mismatch');
      return withAsyncLock(join(store.root, 'capture-locks', data.id), async () => {
        const path = join(store.transfer(data.id), 'return-capture.json');
        const schema = z.object({ originalDigest: Digest, returnId: Id, targetRoot: z.string(), destination: z.literal('local') }).strict();
        const intent = existsSync(path) ? readJson(path, schema) : { originalDigest: data.digest, returnId: data.returnId ?? randomUUID(), targetRoot: resolve(data.targetRoot), destination: data.destination };
        invariant(intent.originalDigest === data.digest && (!data.returnId || intent.returnId === data.returnId) && intent.targetRoot === resolve(data.targetRoot) && intent.destination === data.destination, 'Return capture routing changed');
        atomicWrite(path, json(intent));
        if (existsSync(join(store.transfer(intent.returnId), 'manifest.json'))) {
          const captured = store.manifest(intent.returnId); const reverse = captured.manifest;
          invariant(reverse.parentTransfer === data.id && reverse.lineageId === original.manifest.lineageId && reverse.generation === original.manifest.generation + 1 && reverse.destination === intent.destination && reverse.target.repository === join(intent.targetRoot, 'runs', intent.returnId, 'workspace', 'worktree'), 'Existing return checkpoint binding mismatch');
          const owner = store.owner(reverse.lineageId);
          invariant(owner.transferId === intent.returnId && owner.digest === captured.digest && ((owner.state === 'frozen' && owner.generation + 1 === reverse.generation) || (owner.state === 'fenced' && owner.generation === reverse.generation)), 'Existing return checkpoint no longer owns freeze/fence');
          return { manifest: reverse, digest: captured.digest, checkpoint: store.transfer(intent.returnId) };
        }
        const receipt = store.status(data.id).receipt; invariant(receipt, 'No runtime receipt to pull');
        const reg = store.registration(receipt.sessionId);
        invariant(reg.parentTransfer === data.id && reg.lineageId === original.manifest.lineageId && reg.generation === original.manifest.generation, 'Return registration generation/binding mismatch');
        if (processMatches(reg)) return control(reg.socket, { operation: 'capture', destination: data.destination, targetRoot: intent.targetRoot, instruction: null, id: intent.returnId });
        return captureOffline({ store, registration: reg, destination: data.destination, targetRoot: intent.targetRoot, transferId: intent.returnId });
      });
    }
    case 'approve': { const { id, digest } = bound(store, request.data); store.approve(id, digest); return { approved: true }; }
    case 'fence': { const { id } = bound(store, request.data); verifySource(store, id); store.fence(id); const { manifest, digest } = store.manifest(id); return { fenced: true, transferId: id, digest, lineageId: manifest.lineageId, generation: manifest.generation }; }
    case 'finish': { const { id } = bound(store, request.data); const manifest = store.manifest(id).manifest; const reg = store.registration(manifest.native.sessionId); if (processMatches(reg)) await control(reg.socket, { operation: 'finish', id }); return { finished: true }; }
  }
}
export function prepareRestore(store: Store, id: string) {
  return store.lock(id, () => {
    const manifest = validateCheckpoint(store, id); const { digest } = store.manifest(id);
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
    const native = restoreNative(manifest.native, store.blobs, cwd, join(root, 'native'), id);
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
  prepareRestore(store, id);
  // Multiple command arguments instruct tmux to exec argv directly, not a shell command string.
  run('tmux', ['-L', token, '-f', '/dev/null', 'new-session', '-d', '-s', token, 'bauble', '_runtime', id, '--root', store.root]);
  // Readiness is a durable native receipt, never process presence or screen scraping.
  for (let attempt = 0; attempt < 100; attempt++) { const status = store.status(id); if (status.receipt) return; if (status.execution === 'failed') throw new Error(status.error); await new Promise(ok => setTimeout(ok, 100)); }
  store.update(id, { phase: 'unknown', execution: 'unknown', error: 'No native readiness receipt; reconcile same transfer ID; never restart automatically' });
}
