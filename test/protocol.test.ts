import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { fixtureRoot, fixtureProfile, fixtureRepo, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { createManaged } from '../src/pi/runtime.js';
import { captureCheckpoint } from '../src/checkpoint.js';
import { cancelTransfer, handleRequest, sendCheckpoint, stage } from '../src/protocol.js';
import { internalRuntime } from '../src/commands.js';
import type { Request, Rpc } from '../src/transport.js';
import type { Config } from '../src/schema.js';
import { hash, json, run } from '../src/safe.js';

test('protocol: verified chunks, duplicate starts, lost acknowledgments and real native continuation', async () => {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root); const source = fixtureSession(repo, root); const store = new Store(join(root, 'state'));
  const live = await createManaged({ store, profilePath: profile.path, cwd: repo, manager: source.manager, allowTest: true });
  const reg = await live.settled();
  const configured = join(root, 'destination'); const destination = join(configured, 'fixtures', randomUUID());
  const config: Config = { version: 1, hosts: {}, profile: profile.path, localRoot: store.root, remoteRoot: configured };
  const checkpoint = captureCheckpoint({ store, registration: reg, profile: profile.profile, destination: `h${randomUUID()}`, targetRoot: destination, instruction: 'fixture:write {"path":"continued.txt","content":"native continuation"}', live: live.runtime.session });
  store.approve(checkpoint.manifest.transferId, checkpoint.digest);
  const id = checkpoint.manifest.transferId; let launches = 0; let destinationLive: Awaited<ReturnType<typeof internalRuntime>> | undefined;
  const rpc: Rpc = request => handleRequest(request, { config, allowFixture: true, launch: async (remote, transferId) => { launches++; const { prepareRestore } = await import('../src/protocol.js'); prepareRestore(remote, transferId); destinationLive = await internalRuntime(transferId, remote.root, false); } });
  await stage(store, id, rpc, destination);
  const remoteStore = new Store(destination);
  assert.equal(remoteStore.status(id).phase, 'ready'); assert.equal(launches, 0);
  const changed = structuredClone(checkpoint.manifest); changed.instruction = 'different';
  await assert.rejects(rpc({ operation: 'manifest', root: destination, data: { manifest: changed, digest: hash(json(changed)) } }), /different payload/);
  const losing: Rpc = async request => { const result = await rpc(request); if (request.operation === 'activate') throw new Error('injected lost acknowledgment'); return result; };
  await assert.rejects(sendCheckpoint(store, id, losing, destination), { code: 'AUTHORITY_UNCERTAIN' });
  assert.equal(store.status(id).phase, 'unknown'); assert.equal(store.owner(reg.lineageId).state, 'fenced'); assert.equal(launches, 1);
  await Promise.all([rpc({ operation: 'activate', root: destination, data: { id, digest: checkpoint.digest } }), rpc({ operation: 'activate', root: destination, data: { id, digest: checkpoint.digest } })]);
  assert.equal(launches, 1); assert.equal(remoteStore.status(id).continuation, 'accepted'); assert.ok(remoteStore.status(id).receipt);
  const active = remoteStore.status(id);
  await rpc({ operation: 'approve', root: destination, data: { id, digest: checkpoint.digest } });
  assert.deepEqual(remoteStore.status(id), active, 'Repeated approval must preserve activation evidence');
  await assert.rejects(rpc({ operation: 'revoke', root: destination, data: { id, digest: checkpoint.digest } }), /activation may have happened/);
  assert.equal(run('cat', [join(checkpoint.manifest.target.cwd, 'continued.txt')]).toString(), 'native continuation');
  await destinationLive?.close();
  const exited = remoteStore.status(id);
  assert.equal(exited.execution, 'exited', 'Clean native shutdown must not leave a stale idle observation');
  assert.deepEqual(exited.receipt, active.receipt, 'Shutdown must preserve process/ownership receipt');
  assert.equal(remoteStore.registration(active.receipt!.sessionId).cleanShutdown, true);
  await destinationLive?.close(); assert.deepEqual(remoteStore.status(id), exited, 'Repeated shutdown observation is idempotent');
  await live.close(); rmSync(root, { recursive: true, force: true });
});

test('CLI and SSH gate cannot silently approve or select a newest session', () => {
  assert.throws(() => run(process.execPath, ['dist/src/cli.js', 'send', '--yes']), /USAGE/);
  const root = fixtureRoot(); const store = new Store(join(root, 'state')); assert.throws(() => store.registration('any-session'), /registered session/); rmSync(root, { recursive: true, force: true });
});

test('protocol: durable claim survives approval retry and interrupted launch-intent persistence', async () => {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root); const source = fixtureSession(repo, root); const store = new Store(join(root, 'state'));
  const live = await createManaged({ store, profilePath: profile.path, cwd: repo, manager: source.manager, allowTest: true });
  try {
    const reg = await live.settled();
    const checkpoint = captureCheckpoint({ store, registration: reg, profile: profile.profile, destination: 'fixture-destination', targetRoot: join(root, 'remote'), live: live.runtime.session });
    const id = checkpoint.manifest.transferId;
    // A destination uses the same immutable data but has its own ownership ledger.
    const remote = new Store(join(root, 'remote'));
    remote.putManifest(checkpoint.manifest, 'ready');
    for (const blob of checkpoint.manifest.blobs) remote.blobs.put(store.blobs.get(blob.hash));
    remote.approve(id, checkpoint.digest);
    assert.equal(remote.status(id).phase, 'ready', 'Approval must not move ready backwards');
    const update = remote.update.bind(remote);
    remote.update = (transferId, patch) => { if (patch.phase === 'launch_intent') throw new Error('injected persistence failure'); return update(transferId, patch); };
    assert.throws(() => remote.claim(id), /injected persistence failure/);
    remote.update = update;
    assert.equal(remote.owner(reg.lineageId).state, 'owned');
    assert.equal(remote.status(id).phase, 'ready');
    remote.approve(id, checkpoint.digest);
    assert.throws(() => remote.revoke(id), /activation may have happened/, 'Durable claim must prevent positive revocation even without status acknowledgment');
    assert.throws(() => remote.claim(id), /already claimed or owned/);
  } finally { await live.close(); rmSync(root, { recursive: true, force: true }); }
});

test('protocol: stale cancellation and fencing cannot release or fence another frozen transfer', async () => {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root); const source = fixtureSession(repo, root); const store = new Store(join(root, 'state'));
  const live = await createManaged({ store, profilePath: profile.path, cwd: repo, manager: source.manager, allowTest: true });
  try {
    const reg = await live.settled();
    const checkpoint = captureCheckpoint({ store, registration: reg, profile: profile.profile, destination: 'fixture-destination', targetRoot: join(root, 'remote'), live: live.runtime.session });
    const id = checkpoint.manifest.transferId;
    store.approve(id, checkpoint.digest);
    assert.equal(store.owner(reg.lineageId).transferId, id);
    assert.equal(store.owner(reg.lineageId).digest, checkpoint.digest);
    const nextOwner = { ...store.owner(reg.lineageId), transferId: randomUUID(), digest: hash('another checkpoint') };
    store.setOwner(nextOwner);
    assert.throws(() => store.fence(id), /not frozen for this transfer/);
    const revoked: Rpc = async () => ({ revoked: true, transferId: id, digest: checkpoint.digest });
    await assert.rejects(cancelTransfer(store, id, revoked, join(root, 'remote')), /no longer eligible/);
    assert.deepEqual(store.owner(reg.lineageId), nextOwner);
    // Even a valid old revocation cannot release a later fenced generation.
    const laterOwner = { ...nextOwner, generation: reg.generation + 3, state: 'fenced' as const };
    store.setOwner(laterOwner);
    await assert.rejects(cancelTransfer(store, id, revoked, join(root, 'remote')), /no longer eligible/);
    assert.deepEqual(store.owner(reg.lineageId), laterOwner);
    store.update(id, { phase: 'cancelled' });
    assert.throws(() => store.approve(id, checkpoint.digest), /terminal/);
    assert.throws(() => store.approved(id), /terminal/);
    assert.equal(store.status(id).phase, 'cancelled');
  } finally { await live.close(); rmSync(root, { recursive: true, force: true }); }
});
