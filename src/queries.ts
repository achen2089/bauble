import { captureIntentPath, captureObservation } from './capture-intent.js';
import { findReturn } from './return-route.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { Config, Id, Status, type Manifest } from './schema.js';
import { configPath, loadConfig } from './config.js';
import { invariant, readBytes } from './safe.js';
import { CliError } from './errors.js';
import { action, approvalActions } from './output.js';
import { targetRepository } from './targets.js';
import { ssh, type Rpc } from './transport.js';
export function localStores(selected = new Store(undefined, true)) { const stores = [selected]; if (!process.env.BAUBLE_STATE && existsSync(configPath())) { const config = loadConfig(); if (resolve(config.remoteRoot) !== resolve(selected.root) && existsSync(config.remoteRoot)) stores.push(new Store(resolve(config.remoteRoot), true)); } return stores; }
export function resolveTransfer(input: string, stores = localStores()) {
  const matches = Id.safeParse(input).success ? stores.filter(s => existsSync(join(s.transfer(input), 'manifest.json')) || existsSync(captureIntentPath(s, input)) || !!returnObservation(s, input)).map(store => ({ store, id: input })) : stores.flatMap(store => store.list().filter(r => r.manifest.name === input).map(r => ({ store, id: r.transferId })));
  const ids = [...new Set(matches.map(m => m.id))];
  if (ids.length !== 1) throw new CliError(ids.length ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND', ids.length ? `Name is ambiguous. Candidate UUIDs: ${ids.join(', ')}` : 'No registered transfer matches this exact ID or name.', 'target', 'Select an exact UUID from bauble ls.', { candidates: ids });
  return matches[0]!;
}
export function transferSummary(store: Store, id: string) {
  const { manifest: m, digest } = store.manifest(id); const status = store.status(id);
  invariant(status.transferId === id && status.digest === digest, 'Status binding mismatch');
  return summary(m, status, digest);
}
function summary(m: Manifest, status: Status, digest: string) {
  return { transferId: m.transferId, name: m.name ?? null, kind: m.native.session === null ? 'fresh' : 'session', host: m.destination, source: m.source, target: m.target, phase: status.phase, ownership: status.ownership, execution: status.execution, created: m.created, updated: status.updated, readiness: status.receipt ? 'receipt-recorded' : 'unconfirmed', digest, continuation: status.continuation, task: 'not-tracked' };
}
export function listTransfers(stores = localStores()) { const seen = new Set<string>(); return { transfers: stores.flatMap(store => store.list().filter(row => { if (seen.has(row.transferId)) return false; seen.add(row.transferId); return true; }).map(row => summary(row.manifest, row, row.digest))) }; }
export function sessions(store = new Store(undefined, true)) { return { root: store.root, sessions: store.registrations().map(reg => ({ sessionId: reg.sessionId, sessionFile: reg.sessionFile, cwd: reg.cwd, lineageId: reg.lineageId, generation: reg.generation, parentTransfer: reg.parentTransfer, cleanShutdown: reg.cleanShutdown, recordedOwner: existsSync(store.ownerPath(reg.lineageId)) ? store.owner(reg.lineageId) : null })) }; }
export function inspect(store: Store, id: string) {
  const { manifest, digest } = store.manifest(id); const approvalPath = join(store.transfer(id), 'approval.json');
  let approval: { digest: string; destination: string } | null = null;
  if (existsSync(approvalPath)) { const parsed = JSON.parse(readBytes(approvalPath).toString()); invariant(parsed.digest === digest && parsed.destination === manifest.destination, 'Corrupt approval binding'); approval = { digest, destination: manifest.destination }; }
  return { transferId: id, checkpoint: store.transfer(id), digest, destination: manifest.destination, approval, manifest };
}
export function nextFor(store: Store, id: string) { if (returnObservation(store, id)) return [action('Observe retained return route', 'read', 'status', id), action('Reconcile the same return ID when authorized', 'mutate', 'recover', id)]; const capture = captureObservation(store, id); if (capture && capture.checkpoint !== 'complete') return [action('Observe capture evidence; never recapture', 'read', 'status', id)]; const { digest } = store.manifest(id); const status = store.status(id); if (status.phase === 'cancelled') return [action('Read retained cancellation snapshot', 'read', 'inspect', id)]; if (!existsSync(join(store.transfer(id), 'approval.json'))) return approvalActions(id, digest); return [action('Observe cached state', 'read', 'status', id), action('Reconcile this exact ID if authorized', 'mutate', 'recover', id)]; }
export async function status(store: Store, id: string, refresh = false, connect: (alias: string) => Rpc = ssh, configuration?: Config) {
  const capture = captureObservation(store, id); if (capture && capture.checkpoint !== 'complete') return capture;
  const routeOnly = returnObservation(store, id); if (routeOnly) return routeOnly;
  const summary = transferSummary(store, id); if (!refresh) return { ...summary, observation: 'cached' as const };
  const { manifest, digest } = store.manifest(id); const config = configuration ?? loadConfig(); const route = manifest.destination === 'local' ? findReturn(store, id) : undefined;
  if (route) invariant(route.reverseId === id && route.reverseDigest === digest && route.localRoot === store.root, 'Reverse status routing changed');
  const alias = route?.host ?? manifest.destination; const host = config.hosts[alias];
  if (summary.ownership === 'destination' && existsSync(store.ownerPath(manifest.lineageId)) && store.owner(manifest.lineageId).state === 'owned') return { ...summary, observation: 'local-durable' as const };
  if (!host) throw new CliError('TARGET_NOT_CONFIGURED', 'Destination host is not configured.', 'target');
  if (route) invariant(host.root === route.remoteRoot && manifest.target.repository === join(store.root, 'runs', id, 'workspace', 'worktree'), 'Reverse status destination configuration changed');
  else invariant(manifest.target.repository === targetRepository(manifest, host.root, host.codeRoot), 'Status destination configuration changed');
  const observed = Status.parse(await connect(alias)({ operation: 'status', root: host.root, data: { id, digest } }));
  invariant(observed.transferId === id && observed.digest === digest, 'Remote status binding mismatch');
  if (observed.receipt) invariant(observed.receipt.transferId === id && observed.receipt.digest === digest && observed.receipt.lineageId === manifest.lineageId && observed.receipt.generation === manifest.generation, 'Remote receipt binding mismatch');
  return { ...summary, phase: observed.phase, ownership: observed.ownership, execution: observed.execution, updated: observed.updated, readiness: observed.receipt ? 'receipt-recorded' : 'unconfirmed', observation: 'remote-durable' as const };
}

/** A lost capture ACK leaves a route, not yet a reverse manifest. Resolve only its exact UUID. */
export function returnObservation(store: Store, id: string) {
  if (existsSync(join(store.transfer(id), 'manifest.json'))) return null;
  const route = findReturn(store, id); if (!route || route.reverseId !== id) return null;
  const original = store.manifest(route.originalId); const owner = store.owner(original.manifest.lineageId); const status = store.status(route.originalId);
  invariant(route.localRoot === store.root && route.originalDigest === original.digest && route.host === original.manifest.destination && original.manifest.target.repository === targetRepository(original.manifest, route.remoteRoot, original.manifest.codeRoot) && owner.transferId === route.originalId && owner.digest === original.digest && owner.generation === original.manifest.generation && ['fenced', 'dispatched'].includes(owner.state) && status.digest === original.digest, 'Return route/original binding changed');
  return { transferId: id, originalId: route.originalId, reverseId: id, phase: 'unknown', observation: 'return-route' as const, route, readiness: 'unconfirmed', task: 'not-tracked' };
}
