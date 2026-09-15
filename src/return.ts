import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { Digest, FenceReceipt, Manifest, Registration, ReturnRoute } from './schema.js';
import { atomicWrite, hash, invariant, json, readBytes, readJson, withAsyncLock } from './safe.js';
import { CHUNK, type Rpc } from './transport.js';
import { validateCheckpoint } from './checkpoint.js';
import { prepareRestore } from './protocol.js';
import { processIdentity } from './pi/runtime.js';

const routePath = (store: Store, id: string) => join(store.root, 'returns', `${id}.json`);
export function findReturn(store: Store, id: string): ReturnRoute | undefined {
  const directory = join(store.root, 'returns');
  if (!existsSync(directory)) return undefined;
  const routes = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => readJson(join(directory, name), ReturnRoute)).filter(route => route.originalId === id || route.reverseId === id);
  invariant(routes.length <= 1, 'Ambiguous return routing'); return routes[0];
}
export function beginReturn(store: Store, originalId: string, host: string, remoteRoot: string) {
  const original = store.manifest(originalId);
  return store.lock(original.manifest.lineageId, () => {
    const existing = findReturn(store, originalId);
    if (existing) { invariant(existing.originalDigest === original.digest && existing.host === host && existing.remoteRoot === remoteRoot && existing.localRoot === store.root, 'Return routing changed'); return existing; }
    const owner = store.owner(original.manifest.lineageId);
    invariant(owner.state === 'fenced' && owner.transferId === originalId && owner.digest === original.digest && owner.generation === original.manifest.generation, 'Original transfer no longer owns the local fence');
    const receipt = store.status(originalId).receipt;
    invariant(receipt && receipt.transferId === originalId && receipt.digest === original.digest && receipt.lineageId === original.manifest.lineageId && receipt.generation === original.manifest.generation, 'Destination readiness is not confirmed; recover the outbound transfer before pulling');
    const route = ReturnRoute.parse({ originalId, originalDigest: original.digest, reverseId: randomUUID(), host, remoteRoot, localRoot: store.root, reverseDigest: null });
    atomicWrite(routePath(store, route.reverseId), json(route)); return route;
  });
}
export type ReturnBoundary = 'capture' | 'restoration' | 'fence' | 'claim' | 'registration' | 'returned' | 'finish';
export async function resumeReturn(store: Store, initial: ReturnRoute, rpc: Rpc, approve: (id: string) => Promise<void>, boundary: (point: ReturnBoundary) => void = () => {}) {
  return withAsyncLock(join(store.root, 'return-locks', initial.reverseId), async () => {
    let route = readJson(routePath(store, initial.reverseId), ReturnRoute);
    invariant(route.localRoot === store.root, 'Return local root changed');
    const original = store.manifest(route.originalId); invariant(original.digest === route.originalDigest && original.manifest.destination === route.host, 'Return original binding mismatch');
    const id = route.reverseId; const root = route.remoteRoot;
    const finalPath = join(store.transfer(id), 'return-registration.json');
    const finishedPath = join(store.transfer(id), 'return-finished.json');
    const finish = async (digest: string) => {
      if (existsSync(finishedPath)) { invariant(readBytes(finishedPath).toString() === json({ transferId: id, digest }), 'Return finish binding mismatch'); return; }
      const result = z.object({ finished: z.literal(true) }).strict().parse(await rpc({ operation: 'finish', root, data: { id, digest } }));
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
      const prior = owner.state === 'fenced' && owner.transferId === route.originalId && owner.digest === route.originalDigest && owner.generation === original.manifest.generation;
      const claimed = owner.state === 'owned' && owner.transferId === id && route.reverseDigest !== null && owner.digest === route.reverseDigest && owner.generation === original.manifest.generation + 1;
      invariant(prior || claimed, 'Return ownership changed; refusing stale release');
    };
    store.lock(original.manifest.lineageId, assertEligible);
    const captured = z.object({ manifest: Manifest, digest: Digest, checkpoint: z.string() }).strict().parse(await rpc({ operation: 'capture', root, data: { id: route.originalId, digest: route.originalDigest, targetRoot: store.root, destination: 'local', returnId: id } }));
    const reverse = captured.manifest;
    invariant(hash(json(reverse)) === captured.digest && (!route.reverseDigest || route.reverseDigest === captured.digest), 'Reverse immutable digest mismatch');
    invariant(reverse.transferId === id && reverse.parentTransfer === route.originalId && reverse.lineageId === original.manifest.lineageId && reverse.generation === original.manifest.generation + 1 && reverse.destination === 'local' && reverse.instruction === null, 'Reverse lineage/transfer/instruction mismatch');
    invariant(reverse.target.repository === join(store.root, 'runs', id, 'workspace', 'worktree') && reverse.source.cwd === original.manifest.target.cwd, 'Reverse repository/cwd routing mismatch');
    route = { ...route, reverseDigest: captured.digest }; atomicWrite(routePath(store, id), json(route));
    store.putManifest(reverse, 'staging'); boundary('capture');
    for (const blob of reverse.blobs) if (!store.blobs.has(blob.hash)) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        const data = z.object({ bytes: z.string().max(CHUNK * 2) }).strict().parse(await rpc({ operation: 'download', root, data: { id, digest: blob.hash, offset } }));
        const bytes = Buffer.from(data.bytes, 'base64');
        invariant(bytes.toString('base64') === data.bytes && bytes.length === Math.min(CHUNK, blob.size - offset), 'Invalid reverse chunk'); chunks.push(bytes);
      }
      invariant(store.blobs.put(Buffer.concat(chunks)) === blob.hash, 'Reverse blob corrupt');
    }
    validateCheckpoint(store, id);
    if (!existsSync(join(store.transfer(id), 'approval.json'))) await approve(id);
    store.approved(id);
    await rpc({ operation: 'approve', root, data: { id, digest: captured.digest } });
    if (['staging', 'approved', 'captured'].includes(store.status(id).phase)) store.update(id, { phase: 'ready' });
    invariant(store.status(id).phase === 'ready', 'Return is not eligible for finalization');
    const restored = prepareRestore(store, id); boundary('restoration');
    const fenced = FenceReceipt.parse(await rpc({ operation: 'fence', root, data: { id, digest: captured.digest } }));
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
