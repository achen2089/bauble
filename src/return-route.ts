import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { ReturnRoute } from './schema.js';
import { atomicWrite, invariant, json, readJson } from './safe.js';

export const routePath = (store: Store, id: string) => join(store.root, 'returns', `${id}.json`);
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
    invariant((owner.state === 'fenced' || owner.state === 'dispatched') && owner.transferId === originalId && owner.digest === original.digest && owner.generation === original.manifest.generation, 'Original transfer no longer owns the local fence');
    const receipt = store.status(originalId).receipt;
    invariant(receipt && receipt.transferId === originalId && receipt.digest === original.digest && receipt.lineageId === original.manifest.lineageId && receipt.generation === original.manifest.generation, 'Destination readiness is not confirmed; recover the outbound transfer before pulling');
    const route = ReturnRoute.parse({ originalId, originalDigest: original.digest, reverseId: randomUUID(), host, remoteRoot, localRoot: store.root, reverseDigest: null });
    atomicWrite(routePath(store, route.reverseId), json(route)); return route;
  });
}
