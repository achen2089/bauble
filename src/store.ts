import { CliError } from './errors.js';
import type { ZodType } from 'zod';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Blobs } from './blobs.js';
import { Manifest, Status, Owner, Registration, Id, Digest, type Receipt } from './schema.js';
import { appendJournal, atomicWrite, hash, invariant, json, privateDir, readBytes, readJson, withLock } from './safe.js';
import { stateRoot } from './config.js';
function record<T>(path: string, schema: ZodType<T>): T { try { return readJson(path, schema); } catch { throw new CliError('CORRUPT_STATE', `State record is invalid or unavailable: ${path}`, 'target', 'Retain state; investigate the exact record rather than deleting it.'); } }
export class Store {
  readonly blobs: Blobs;
  constructor(readonly root = stateRoot(), readonly readOnly = false) { if (!readOnly) privateDir(root); this.blobs = new Blobs(join(root, 'blobs'), readOnly); }
  registrations() { const dir = join(this.root, 'sessions'); return existsSync(dir) ? readdirSync(dir).map(file => record(join(dir, file), Registration)) : []; }
  transfer(id: string) { return join(this.root, 'transfers', Id.parse(id)); }
  ownerPath(id: string) { return join(this.root, 'lineages', `${Id.parse(id)}.json`); }
  owner(id: string) { return record(this.ownerPath(id), Owner); }
  setOwner(owner: Owner) { atomicWrite(this.ownerPath(owner.lineageId), json(Owner.parse(owner))); }
  lock<T>(id: string, fn: () => T) { return withLock(join(this.root, 'locks', Id.parse(id)), fn); }
  registration(fileOrId: string): Registration {
    const matches = this.registrations().filter(r => r.sessionId === fileOrId || resolve(r.sessionFile) === resolve(fileOrId));
    invariant(matches.length === 1, 'Select one registered session path/id. Bare files require explicit bauble pi --session <path> adoption; never selecting newest transcript.'); return matches[0]!;
  }
  register(reg: Registration) { atomicWrite(join(this.root, 'sessions', `${hash(reg.sessionFile)}.json`), json(Registration.parse(reg))); }
  status(id: string) { return record(join(this.transfer(id), 'status.json'), Status); }
  manifest(id: string) {
    const path = join(this.transfer(id), 'manifest.json');
    try { const bytes = readBytes(path); const manifest = Manifest.parse(JSON.parse(bytes.toString())); invariant(manifest.transferId === id, 'Transfer identity mismatch'); return { manifest, digest: hash(bytes), bytes }; }
    catch { throw new CliError('CORRUPT_STATE', `Immutable manifest is invalid or unavailable: ${path}`, 'target', 'Retain the exact checkpoint and investigate; never recapture to bypass corruption.'); }
  }
  event(id: string, event: unknown) { appendJournal(join(this.transfer(id), 'journal.jsonl'), event); }
  update(id: string, patch: Partial<Status>) {
    const old = this.status(id); const next = Status.parse({ ...old, ...patch, updated: new Date().toISOString() });
    invariant(old.transferId === next.transferId && old.digest === next.digest, 'Status binding cannot change');
    if (old.phase === 'cancelled') invariant(next.phase === 'cancelled', 'Cancellation tombstone is terminal');
    this.event(id, { previous: old.phase, status: next }); atomicWrite(join(this.transfer(id), 'status.json'), json(next)); return next;
  }
  putManifest(manifest: Manifest, initial: Status['phase'] = 'captured') {
    Manifest.parse(manifest); const bytes = Buffer.from(json(manifest)); const digest = hash(bytes); const dir = this.transfer(manifest.transferId);
    if (existsSync(join(dir, 'manifest.json'))) { invariant(hash(readBytes(join(dir, 'manifest.json'))) === digest, 'Duplicate transfer ID with different payload'); return digest; }
    privateDir(dir); atomicWrite(join(dir, 'manifest.json'), bytes);
    atomicWrite(join(dir, 'status.json'), json({ transferId: manifest.transferId, digest, phase: initial, ownership: 'source', execution: 'unknown', updated: new Date().toISOString(), continuation: manifest.instruction === null ? 'none' : 'intent' } satisfies Status));
    this.event(manifest.transferId, { phase: initial, digest }); return digest;
  }
  approve(id: string, digest: string) {
    const { manifest } = this.manifest(id);
    return this.lock(manifest.lineageId, () => {
      const m = this.manifest(id); invariant(m.digest === Digest.parse(digest), 'Approval digest mismatch');
      const status = this.status(id); invariant(status.phase !== 'cancelled', 'Cancellation tombstone is terminal');
      atomicWrite(join(this.transfer(id), 'approval.json'), json({ digest, destination: m.manifest.destination }));
      // Approval retries must not erase launch intent or evidence of activation.
      if (['captured', 'staging'].includes(status.phase)) this.update(id, { phase: 'approved' });
    });
  }
  approved(id: string) { const { digest, manifest } = this.manifest(id); invariant(this.status(id).phase !== 'cancelled', 'Cancellation tombstone is terminal'); const value = JSON.parse(readBytes(join(this.transfer(id), 'approval.json')).toString()); invariant(value.digest === digest && value.destination === manifest.destination, 'Missing/mismatched approval binding'); return { digest, manifest }; }
  verify(id: string) {
    const { manifest, digest } = this.manifest(id); const seen = new Set<string>();
    for (const blob of manifest.blobs) { invariant(!seen.has(blob.hash), 'Duplicate blob inventory'); seen.add(blob.hash); invariant(this.blobs.get(blob.hash).length === blob.size, 'Blob size mismatch'); }
    const required = [...(manifest.workspace.bundle ? [manifest.workspace.bundle] : []), ...manifest.workspace.index.map(i => i.hash), ...manifest.workspace.files.flatMap(f => f.hash ? [f.hash] : []), ...(manifest.native.session ? [manifest.native.session] : []), ...((manifest.inputs ?? []).map(i => i.hash)), ...manifest.native.resources.map(r => r.hash), ...manifest.native.artifacts.map(a => a.hash)];
    invariant(required.every(h => seen.has(h)), 'Referenced blob absent from approved inventory'); return { manifest, digest };
  }
  fence(id: string) {
    const { manifest, digest } = this.approved(id);
    this.lock(manifest.lineageId, () => { const owner = this.owner(manifest.lineageId);
      if (owner.state === 'fenced' && owner.transferId === id && owner.digest === digest && owner.generation === manifest.generation) return;
      invariant(owner.state === 'frozen' && owner.generation + 1 === manifest.generation && owner.transferId === id && owner.digest === digest, 'Source not frozen for this transfer at expected generation');
      this.setOwner({ lineageId: manifest.lineageId, generation: manifest.generation, transferId: id, state: 'fenced', digest });
      this.update(id, { phase: 'fenced', ownership: 'fenced' });
    });
  }
  claim(id: string) {
    const { manifest, digest } = this.verify(id);
    return this.lock(manifest.lineageId, () => {
      const status = this.status(id); invariant(status.phase !== 'cancelled', 'Activation revoked by durable tombstone');
      if (['launch_intent', 'active', 'unknown'].includes(status.phase)) return false;
      invariant(status.phase === 'ready', 'Destination not ready');
      if (existsSync(this.ownerPath(manifest.lineageId))) { const owner = this.owner(manifest.lineageId); invariant(owner.generation < manifest.generation && owner.state === 'fenced', 'Lineage generation already claimed or owned'); }
      this.setOwner({ lineageId: manifest.lineageId, generation: manifest.generation, transferId: id, state: 'owned', digest });
      this.update(id, { phase: 'launch_intent', ownership: 'destination', execution: 'starting' }); return true;
    });
  }
  revoke(id: string) {
    const { manifest } = this.manifest(id);
    return this.lock(manifest.lineageId, () => { const status = this.status(id);
      const owner = existsSync(this.ownerPath(manifest.lineageId)) ? this.owner(manifest.lineageId) : undefined;
      invariant(!status.receipt && !(owner?.transferId === id && owner.generation === manifest.generation && owner.state === 'owned') && !['launch_intent', 'active', 'unknown', 'returned'].includes(status.phase), 'Runtime activation may have happened; must pull or reconcile, never cancel'); this.update(id, { phase: 'cancelled', ownership: 'revoked' }); return { revoked: true, transferId: id, digest: status.digest }; });
  }
  receipt(id: string, receipt: Receipt) { const { manifest, digest } = this.manifest(id); invariant(receipt.transferId === id && receipt.lineageId === manifest.lineageId && receipt.generation === manifest.generation && receipt.digest === digest, 'Receipt binding mismatch'); this.update(id, { phase: 'active', ownership: 'destination', execution: 'idle', receipt }); }
  list() { const dir = join(this.root, 'transfers'); return existsSync(dir) ? readdirSync(dir).map(id => { if (!Id.safeParse(id).success) throw new CliError('CORRUPT_STATE', `Invalid transfer record name: ${id}`, 'target'); const status = this.status(id); const { manifest, digest } = this.manifest(id); invariant(status.transferId === id && status.digest === digest, 'Status binding mismatch'); return { ...status, manifest }; }) : []; }
}
