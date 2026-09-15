import { z } from 'zod';
import { existsSync, openSync, closeSync, writeSync, fsyncSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Digest, Id, Manifest, Receipt, type Config } from './schema.js';
import { atomicWrite, hash, invariant, json, readBytes, readJson, run, withAsyncLock } from './safe.js';
import { CHUNK, control, type Request } from './transport.js';
import { targetRepository } from './targets.js';
import { processMatches } from './process.js';
import { VERSION, PI_VERSION } from './metadata.js';
import { readLog, LogCursor } from './log.js';

/** Dispatch cheap storage/observation requests without loading Pi or checkpoint code. */
function bound(store: Store, data: unknown) { const value = z.object({ id: Id, digest: Digest }).strict().parse(data); invariant(store.manifest(value.id).digest === value.digest, 'Manifest binding mismatch'); return value; }
export interface HelperOptions { config: Config; allowFixture?: boolean; launch?: (store: Store, id: string) => Promise<void> }
export async function handleRequest(request: Request, options: HelperOptions): Promise<unknown> {
  const root = ['probe', 'configure-code-root'].includes(request.operation) && request.root === '' ? resolve(options.config.remoteRoot) : resolve(request.root); const configured = resolve(options.config.remoteRoot);
  const fixture = options.allowFixture && root.startsWith(join(configured, 'fixtures') + '/') && Id.safeParse(root.slice(join(configured, 'fixtures').length + 1)).success;
  invariant(root === configured || fixture, 'Remote root must match configured storage or an explicitly authorized UUID fixture');
  const store = new Store(root, ['status', 'log', 'attach', 'message-check', 'message-status'].includes(request.operation));
  switch (request.operation) {
    case 'configure-code-root': { const data = z.object({ codeRoot: z.string().max(4096) }).strict().parse(request.data); return (await import('./hosts.js')).configureCodeRoot(data.codeRoot); }
    case 'probe': {
      if (options.config.codeRoot) (await import('./hosts.js')).validateCodeRoot(options.config.codeRoot, root);
      const { readProfile, checkRequirements, validateModel, snapshotProfile } = await import('./pi/profile.js');
      invariant(process.platform === 'linux', 'Remote host must be Linux');
      const node = process.versions.node.split('.').map(Number); invariant(node[0]! > 22 || (node[0] === 22 && node[1]! >= 19), 'Node >=22.19.0 required');
      run('git', ['--version']); const tmux = run('tmux', ['-V']).toString(); const match = /tmux (\d+)\.(\d+)/.exec(tmux); invariant(match && (+match[1]! > 3 || (+match[1]! === 3 && +match[2]! >= 2)), 'tmux >=3.2 required');
      const profile = readProfile(options.config.profile); await checkRequirements(profile); await validateModel(profile, root, true);
      return { protocol: 1, version: VERSION, piVersion: PI_VERSION, node: process.versions.node, tmux: tmux.trim(), root, codeRoot: options.config.codeRoot, profileDigest: snapshotProfile(profile, dirname(options.config.profile), store.blobs).digest };
    }
    case 'manifest': {
      const data = z.object({ manifest: Manifest, digest: Digest }).strict().parse(request.data);
      invariant(hash(json(data.manifest)) === data.digest, 'Corrupt manifest');
      invariant(data.manifest.native.profile.testOnly ? fixture : true, 'Test profile forbidden outside isolated fixture root');
      const expected = targetRepository(data.manifest, root, options.config.codeRoot); invariant(data.manifest.target.repository === expected, 'Target path not Bauble-owned transfer root');
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
      const { validateCheckpoint } = await import('./checkpoint.js');
      const { readProfile, snapshotProfile, checkRequirements, validateModel } = await import('./pi/profile.js');
      const { id, digest } = bound(store, request.data); const manifest = validateCheckpoint(store, id);
      invariant(manifest.target.repository === targetRepository(manifest, root, options.config.codeRoot), 'Destination authorization changed');
      if (manifest.codeRoot) (await import('./hosts.js')).validateCodeRoot(manifest.codeRoot, root);
      if (!manifest.native.profile.testOnly) { const profile = readProfile(options.config.profile); invariant(snapshotProfile(profile, dirname(options.config.profile), store.blobs).digest === manifest.native.profileDigest, 'Destination profile mismatch'); await checkRequirements(profile); await validateModel(profile, root, true); }
      invariant(store.status(id).phase !== 'cancelled', 'Transfer revoked');
      if (store.status(id).phase === 'staging') store.update(id, { phase: 'ready' });
      return { ready: true, digest };
    }
    case 'activate': {
      const { id } = bound(store, request.data); const manifest = store.manifest(id).manifest;
      invariant(manifest.target.repository === targetRepository(manifest, root, options.config.codeRoot), 'Destination authorization changed');
      if (manifest.codeRoot) (await import('./hosts.js')).validateCodeRoot(manifest.codeRoot, root);
      if (store.claim(id)) {
        try { await (options.launch ?? (await import('./protocol.js')).launchTmux)(store, id); }
        catch (e) { store.update(id, { phase: 'unknown', execution: 'unknown', error: String(e) }); throw e; }
      }
      return store.status(id);
    }
    case 'status': { const { id } = bound(store, request.data); return store.status(id); }
    case 'revoke': { const { id } = bound(store, request.data); return store.revoke(id); }
    case 'attach': {
      const { id } = bound(store, request.data); return (await import('./attachment.js')).verifyLocalAttachment(store, id);
    }
    case 'message-check': { const data = z.object({ receipt: Receipt }).strict().parse(request.data); return (await import('./message.js')).checkMessageRuntime(store, data.receipt); }
    case 'message': return (await import('./message.js')).deliverMessageLocal(store, request.data);
    case 'message-status': return (await import('./message.js')).messageStatusLocal(store, request.data);
    case 'log': { const { id, digest, cursor } = z.object({ id: Id, digest: Digest, cursor: LogCursor.optional() }).strict().parse(request.data); invariant(store.manifest(id).digest === digest, 'Log binding mismatch'); return readLog(join(store.transfer(id), 'run.log'), cursor); }
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
        if (!reg.cleanShutdown && processMatches(reg)) return control(reg.socket, { operation: 'capture', destination: data.destination, targetRoot: intent.targetRoot, instruction: null, id: intent.returnId });
        return (await import('./checkpoint.js')).captureOffline({ store, registration: reg, destination: data.destination, targetRoot: intent.targetRoot, transferId: intent.returnId });
      });
    }
    case 'approve': { const { id, digest } = bound(store, request.data); store.approve(id, digest); return { approved: true }; }
    case 'fence': { const { verifySource } = await import('./checkpoint.js'); const { id } = bound(store, request.data); verifySource(store, id); store.fence(id); const { manifest, digest } = store.manifest(id); return { fenced: true, transferId: id, digest, lineageId: manifest.lineageId, generation: manifest.generation }; }
    case 'finish': { const { id } = bound(store, request.data); const manifest = store.manifest(id).manifest; invariant(manifest.native.sessionId, 'Fresh task has no source session'); const reg = store.registration(manifest.native.sessionId); if (!reg.cleanShutdown && processMatches(reg)) await control(reg.socket, { operation: 'finish', id }); return { finished: true }; }
  }
}
