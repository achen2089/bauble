import { prepared } from './approval.js';
import { action, type OperationContext, type Prepared } from './output.js';
import { CliError, withStreamCapability } from './errors.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { Digest, FenceReceipt, Manifest, Registration, ReturnRoute, Status } from './schema.js';
import { atomicWrite, hash, invariant, json, readBytes, readJson, withAsyncLock } from './safe.js';
import { CHUNK, type Rpc } from './transport.js';
import { validateCheckpoint } from './checkpoint.js';
import { prepareRestore } from './protocol.js';
import { processIdentity } from './process.js';

import { routePath } from './return-route.js';
export { beginReturn, findReturn } from './return-route.js';

export type ReturnBoundary = 'capture' | 'restoration' | 'fence' | 'claim' | 'registration' | 'returned' | 'finish';
export function resumeReturn(store: Store, initial: ReturnRoute, rpc: Rpc, approve: (id: string) => Promise<void>, boundary?: (point: ReturnBoundary) => void): Promise<Registration>;
export function resumeReturn(store: Store, initial: ReturnRoute, rpc: Rpc, approve: (id: string) => Promise<void>, boundary: ((point: ReturnBoundary) => void) | undefined, options: OperationContext & { prepare?: boolean; approvalDigest?: string }): Promise<Registration | Prepared>;
export async function resumeReturn(store: Store, initial: ReturnRoute, rpc: Rpc, approve: (id: string) => Promise<void>, boundary: (point: ReturnBoundary) => void = () => {}, options: OperationContext & { prepare?: boolean; approvalDigest?: string } = {}): Promise<Registration | Prepared> {
  return withAsyncLock(join(store.root, 'return-locks', initial.reverseId), async () => {
    let route = readJson(routePath(store, initial.reverseId), ReturnRoute);
    invariant(route.localRoot === store.root, 'Return local root changed');
    const original = store.manifest(route.originalId); invariant(original.digest === route.originalDigest && original.manifest.destination === route.host, 'Return original binding mismatch');
    const id = route.reverseId; const root = route.remoteRoot;
    // Every request belongs to an existing durable route, including read-only retries
    // after a lost fencing ACK. A connection failure cannot erase that uncertainty.
    const requestRemote: Rpc = async request => {
      try { return await rpc(request); }
      catch (error) { throw withStreamCapability(error, new CliError('RETURN_UNCERTAIN', `Return ${request.operation} acknowledgment is unavailable; preserve the existing route.`, 'uncertain', 'Reconcile the exact reverse ID; never recapture or remove state.', { originalId: route.originalId, reverseId: id }, [action('Observe reverse route', 'read', 'status', id), action('Reconcile existing return when authorized', 'mutate', 'recover', id)])); }
    };
    if (options.approvalDigest && route.reverseDigest && options.approvalDigest !== route.reverseDigest) throw new CliError('APPROVAL_MISMATCH', 'Explicit approval differs from the existing reverse snapshot.', 'approval', 'Inspect the exact reverse ID.', { originalId: route.originalId, reverseId: id, digest: route.reverseDigest });
    if (options.prepare && existsSync(join(store.transfer(id), 'manifest.json'))) {
      const phase = store.status(id).phase;
      if (existsSync(join(store.transfer(id), 'approval.json')) || !['captured', 'staging'].includes(phase)) throw new CliError('PHASE_CONFLICT', 'Return preparation cannot undo approval or finalization.', 'target', 'Observe or recover this existing reverse route; do not capture again.', { originalId: route.originalId, reverseId: id, phase }, [action('Observe the exact reverse route', 'read', 'status', id), action('Reconcile existing return when authorized', 'mutate', 'recover', id)]);
    }
    const finalPath = join(store.transfer(id), 'return-registration.json');
    const finishedPath = join(store.transfer(id), 'return-finished.json');
    const finish = async (digest: string) => {
      if (existsSync(finishedPath)) { invariant(readBytes(finishedPath).toString() === json({ transferId: id, digest }), 'Return finish binding mismatch'); return; }
      const result = z.object({ finished: z.literal(true) }).strict().parse(await requestRemote({ operation: 'finish', root, data: { id, digest } }));
      invariant(result.finished, 'Source did not acknowledge finish');
      atomicWrite(finishedPath, json({ transferId: id, digest })); boundary('finish');
    };
    // Completion is not permission to overwrite a registration that the user has since opened.
    if (existsSync(finalPath) && store.status(id).phase === 'returned') {
      const expected = readJson(finalPath, Registration);
      invariant(route.reverseDigest === store.manifest(id).digest, 'Returned digest mismatch');
      const current = store.registration(expected.sessionFile);
      invariant(current.sessionId === expected.sessionId && current.lineageId === expected.lineageId && current.generation === expected.generation, 'Returned registration binding changed');
      await finish(route.reverseDigest!); return current;
    }
    const assertEligible = () => {
      const owner = store.owner(original.manifest.lineageId);
      const prior = (owner.state === 'fenced' || owner.state === 'dispatched') && owner.transferId === route.originalId && owner.digest === route.originalDigest && owner.generation === original.manifest.generation;
      const claimed = owner.state === 'owned' && owner.transferId === id && route.reverseDigest !== null && owner.digest === route.reverseDigest && owner.generation === original.manifest.generation + 1;
      invariant(prior || claimed, 'Return ownership changed; refusing stale release');
    };
    store.lock(original.manifest.lineageId, assertEligible);
    options.progress?.('capture');
    const captured = route.reverseDigest && existsSync(join(store.transfer(id), 'manifest.json'))
      ? { ...store.manifest(id), checkpoint: store.transfer(id) }
      : z.object({ manifest: Manifest, digest: Digest, checkpoint: z.string() }).strict().parse(await requestRemote({ operation: 'capture', root, data: { id: route.originalId, digest: route.originalDigest, targetRoot: store.root, destination: 'local', returnId: id } }));
    const reverse = captured.manifest;
    invariant(hash(json(reverse)) === captured.digest && (!route.reverseDigest || route.reverseDigest === captured.digest), 'Reverse immutable digest mismatch');
    invariant(reverse.transferId === id && reverse.parentTransfer === route.originalId && reverse.lineageId === original.manifest.lineageId && reverse.generation === original.manifest.generation + 1 && reverse.destination === 'local' && reverse.instruction === null, 'Reverse lineage/transfer/instruction mismatch');
    invariant(reverse.target.repository === join(store.root, 'runs', id, 'workspace', 'worktree') && reverse.source.cwd === original.manifest.target.cwd, 'Reverse repository/cwd routing mismatch');
    route = { ...route, reverseDigest: captured.digest }; atomicWrite(routePath(store, id), json(route));
    store.putManifest(reverse, 'staging'); boundary('capture');
    options.progress?.('download');
    for (const blob of reverse.blobs) if (!store.blobs.has(blob.hash)) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        const data = z.object({ bytes: z.string().max(CHUNK * 2) }).strict().parse(await requestRemote({ operation: 'download', root, data: { id, digest: blob.hash, offset } }));
        const bytes = Buffer.from(data.bytes, 'base64');
        invariant(bytes.toString('base64') === data.bytes && bytes.length === Math.min(CHUNK, blob.size - offset), 'Invalid reverse chunk'); chunks.push(bytes);
      }
      invariant(store.blobs.put(Buffer.concat(chunks)) === blob.hash, 'Reverse blob corrupt');
    }
    options.progress?.('verify'); validateCheckpoint(store, id);
    const snapshot = { ...prepared(store, id, false), originalId: route.originalId, reverseId: id, remoteFrozen: true };
    if (options.prepare || !existsSync(join(store.transfer(id), 'approval.json'))) {
      const observed = Status.parse(await requestRemote({ operation: 'status', root, data: { id, digest: captured.digest } }));
      invariant(observed.transferId === id && observed.digest === captured.digest, 'Reverse status binding mismatch');
      if (observed.phase !== 'captured' || observed.ownership !== 'source') throw new CliError('PHASE_CONFLICT', 'Remote reverse checkpoint has progressed beyond unapproved preparation.', 'target', 'Observe or recover the exact reverse route.', { originalId: route.originalId, reverseId: id, phase: observed.phase }, [action('Observe reverse route', 'read', 'status', id), action('Reconcile existing return when authorized', 'mutate', 'recover', id)]);
      options.onDurable?.(snapshot); if (options.prepare) return snapshot;
    }
    options.onDurable?.({ originalId: route.originalId, reverseId: id, digest: captured.digest, checkpoint: store.transfer(id) });
    if (!existsSync(join(store.transfer(id), 'approval.json'))) await approve(id);
    store.approved(id);
    await requestRemote({ operation: 'approve', root, data: { id, digest: captured.digest } });
    if (['staging', 'approved', 'captured'].includes(store.status(id).phase)) store.update(id, { phase: 'ready' });
    invariant(store.status(id).phase === 'ready', 'Return is not eligible for finalization');
    const restored = prepareRestore(store, id); boundary('restoration');
    const fenced = FenceReceipt.parse(await requestRemote({ operation: 'fence', root, data: { id, digest: captured.digest } }));
    invariant(fenced.transferId === id && fenced.digest === captured.digest && fenced.lineageId === reverse.lineageId && fenced.generation === reverse.generation, 'Reverse fence receipt mismatch');
    atomicWrite(join(store.transfer(id), 'return-fence.json'), json(fenced)); boundary('fence');
    const reg = store.lock(reverse.lineageId, () => {
      assertEligible(); store.approved(id);
      invariant(store.status(id).phase === 'ready', 'Return cancelled or changed before ownership release');
      prepareRestore(store, id); // Recheck local materialization after the fencing RPC.
      const expected = Registration.parse({ ...restored, lineageId: reverse.lineageId, generation: reverse.generation, parentTransfer: id, profileDigest: reverse.native.profileDigest, runtimeSignature: reverse.native.runtimeSignature, cleanShutdown: true, sessionHash: hash(readBytes(restored.sessionFile)), pid: process.pid, nonce: randomUUID(), start: processIdentity(), socket: '' });
      const registration = existsSync(finalPath) ? readJson(finalPath, Registration) : expected;
      invariant(json(registration) === json({ ...expected, pid: registration.pid, start: registration.start, nonce: registration.nonce }), 'Return registration receipt mismatch');
      const registrationPath = join(store.root, 'sessions', `${hash(registration.sessionFile)}.json`);
      if (existsSync(registrationPath)) invariant(json(readJson(registrationPath, Registration)) === json(registration), 'Returned session was subsequently opened/changed; refusing to overwrite registration');
      else invariant(!existsSync(join(store.root, 'runtime-locks', reverse.lineageId)), 'A lineage runtime is still present; close/reconcile it before local release');
      atomicWrite(finalPath, json(registration));
      store.setOwner({ lineageId: reverse.lineageId, generation: reverse.generation, transferId: id, state: 'owned', digest: captured.digest }); boundary('claim');
      store.register(registration); boundary('registration');
      store.update(id, { phase: 'returned', ownership: 'destination', execution: 'exited' }); boundary('returned');
      return registration;
    });
    await finish(captured.digest); return reg;
  });
}
