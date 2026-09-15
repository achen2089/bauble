import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { fixtureRoot, fixtureRepo, fixtureProfile, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { createManaged } from '../src/pi/runtime.js';
import { captureLive, internalRuntime, recover, pull } from '../src/commands.js';
import { captureCheckpoint, captureOffline } from '../src/checkpoint.js';
import { handleRequest, prepareRestore, sendCheckpoint, stage } from '../src/protocol.js';
import { beginReturn, findReturn, resumeReturn, type ReturnBoundary } from '../src/return.js';
import { type Config } from '../src/schema.js';
import { type Rpc } from '../src/transport.js';
import { atomicWrite } from '../src/safe.js';

async function sourceFixture() {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root); const session = fixtureSession(repo, root); const store = new Store(join(root, 'state'));
  const live = await createManaged({ store, profilePath: profile.path, cwd: repo, manager: session.manager, allowTest: true });
  const configured = join(root, 'remote'); const destination = join(configured, 'fixtures', randomUUID()); const alias = `h${randomUUID()}`;
  const config: Config = { version: 1, hosts: { [alias]: { root: destination, profileDigest: live.registration.profileDigest } }, profile: profile.path, localRoot: store.root, remoteRoot: configured };
  return { root, repo, profile, session, store, live, configured, destination, alias, config };
}
async function returnFixture() {
  const f = await sourceFixture(); const reg = await f.live.settled();
  const captured = captureCheckpoint({ store: f.store, registration: reg, profile: f.profile.profile, destination: f.alias, targetRoot: f.destination, live: f.live.runtime.session });
  f.store.approve(captured.manifest.transferId, captured.digest);
  let launches = 0; let remoteLive: Awaited<ReturnType<typeof internalRuntime>> | undefined;
  const rpc: Rpc = request => handleRequest(request, { config: f.config, allowFixture: true, launch: async (store, id) => { launches++; prepareRestore(store, id); remoteLive = await internalRuntime(id, store.root, false); } });
  await sendCheckpoint(f.store, captured.manifest.transferId, rpc, f.destination);
  await remoteLive!.runtime.session.prompt('fixture:write {"path":"remote-result.txt","content":"native remote result"}', { expandPromptTemplates: false });
  await remoteLive!.close(); await f.live.close();
  const remote = new Store(f.destination); const receipt = remote.status(captured.manifest.transferId).receipt!;
  // Model a positively cleanly stopped process (the embedded test runtime shares this test PID).
  const remoteReg = remote.registration(receipt.sessionId); remote.register({ ...remoteReg, pid: 2147483647, start: 'exited fixture process' });
  writeFileSync(join(f.repo, 'newer-local.txt'), 'do not overwrite newer original edits');
  return { ...f, captured, rpc, remote, launches: () => launches };
}
const approve = (store: Store) => async (id: string) => { store.approve(id, store.manifest(id).digest); };

test('commands.recover: cancelled T1 on A and stale noncancelled T1 cannot activate after T2 owns B', async () => {
  const f = await sourceFixture();
  try {
    const reg = await f.live.settled();
    const first = captureCheckpoint({ store: f.store, registration: reg, profile: f.profile.profile, destination: f.alias, targetRoot: f.destination, live: f.live.runtime.session });
    f.store.approve(first.manifest.transferId, first.digest);
    const calls: string[] = [];
    const rpc: Rpc = request => { calls.push(request.operation); return handleRequest(request, { config: f.config, allowFixture: true, launch: async () => {} }); };
    await stage(f.store, first.manifest.transferId, rpc, f.destination);
    await f.live.close(); f.store.register({ ...f.store.registration(reg.sessionId), pid: 2147483647, start: 'exited' });
    await recover(first.manifest.transferId, true, f.store, { config: f.config, connect: () => rpc });
    const aliasB = `h${randomUUID()}`; const destinationB = join(f.configured, 'fixtures', randomUUID());
    f.config.hosts[aliasB] = { root: destinationB, profileDigest: reg.profileDigest };
    const second = captureOffline({ store: f.store, registration: f.store.registration(reg.sessionId), destination: aliasB, targetRoot: destinationB });
    f.store.approve(second.manifest.transferId, second.digest);
    await sendCheckpoint(f.store, second.manifest.transferId, rpc, destinationB);
    const before = calls.length;
    await assert.rejects(recover(first.manifest.transferId, false, f.store, { config: f.config, connect: () => rpc }), /terminal/);
    assert.equal(calls.length, before, 'Cancelled recovery must make zero RPCs');
    assert.equal(new Store(f.destination).status(first.manifest.transferId).phase, 'ready');
    assert.equal(new Store(destinationB).owner(reg.lineageId).transferId, second.manifest.transferId);
    // Also check exact binding independently of the terminal cancellation guard.
    const stale = { ...first.manifest, transferId: randomUUID() }; const digest = f.store.putManifest(stale); f.store.approve(stale.transferId, digest);
    await assert.rejects(recover(stale.transferId, false, f.store, { config: f.config, connect: () => rpc }), /does not match/);
    assert.equal(calls.length, before);
  } finally { await f.live.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('commands.recover: approved checkpoint resumes staging against an empty destination', async () => {
  const f = await sourceFixture();
  try {
    const checkpoint = await captureLive(f.live, f.store, { destination: f.alias, targetRoot: f.destination }); f.store.approve(checkpoint.manifest.transferId, checkpoint.digest);
    const calls: string[] = [];
    const rpc: Rpc = request => { calls.push(request.operation); return handleRequest(request, { config: f.config, allowFixture: true, launch: async () => {} }); };
    await recover(checkpoint.manifest.transferId, false, f.store, { config: f.config, connect: () => rpc });
    assert.equal(calls[0], 'manifest'); assert.equal(calls.filter(op => op === 'activate').length, 1);
    assert.equal(f.store.owner(checkpoint.manifest.lineageId).state, 'fenced');
  } finally { await f.live.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('premature pull leaves outbound recovery available after activation dispatch failure', async () => {
  const f = await sourceFixture();
  try {
    const checkpoint = await captureLive(f.live, f.store, { destination: f.alias, targetRoot: f.destination });
    const id = checkpoint.manifest.transferId; f.store.approve(id, checkpoint.digest);
    let failActivation = true; let launches = 0;
    const rpc: Rpc = request => {
      if (request.operation === 'activate' && failActivation) throw new Error('activation not dispatched');
      return handleRequest(request, { config: f.config, allowFixture: true, launch: async () => { launches++; } });
    };
    await assert.rejects(sendCheckpoint(f.store, id, rpc, f.destination), /activation not dispatched/);
    assert.equal(new Store(f.destination).status(id).phase, 'ready');
    assert.throws(() => beginReturn(f.store, id, f.alias, f.destination), /recover the outbound transfer/);
    assert.equal(findReturn(f.store, id), undefined);
    failActivation = false;
    await recover(id, false, f.store, { config: f.config, connect: () => rpc });
    assert.equal(launches, 1);
    await recover(id, false, f.store, { config: f.config, connect: () => rpc });
    assert.equal(launches, 1, 'Recovery must not duplicate activation');
  } finally { await f.live.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('live duplicate capture preserves earlier frozen binding and rejects input', async () => {
  const f = await sourceFixture();
  try {
    const checkpoint = await captureLive(f.live, f.store, { destination: f.alias, targetRoot: f.destination });
    const before = f.store.owner(checkpoint.manifest.lineageId);
    await assert.rejects(captureLive(f.live, f.store, { destination: f.alias, targetRoot: f.destination }), /frozen/);
    assert.deepEqual(f.store.owner(checkpoint.manifest.lineageId), before);
    assert.equal(f.live.guard.phase, 'frozen');
    assert.throws(() => f.live.runtime.session.prompt('unapproved input'), /frozen/);
  } finally { await f.live.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('offline return capture failure restores only unchanged prepublication owner; generation mismatch rejects', async () => {
  const f = await returnFixture();
  try {
    const originalId = f.captured.manifest.transferId; const route = beginReturn(f.store, originalId, f.alias, f.destination);
    const lineage = f.captured.manifest.lineageId; const before = f.remote.owner(lineage);
    const artifact = f.captured.manifest.native.artifacts[0]!; const path = join(f.destination, 'runs', originalId, 'native', 'artifacts', artifact.hash); unlinkSync(path);
    const request = { operation: 'capture' as const, root: f.destination, data: { id: originalId, digest: f.captured.digest, targetRoot: f.store.root, destination: 'local', returnId: route.reverseId } };
    await assert.rejects(f.rpc(request), /ENOENT/);
    assert.deepEqual(f.remote.owner(lineage), before); assert.equal(existsSync(join(f.remote.transfer(route.reverseId), 'manifest.json')), false);
    atomicWrite(path, f.remote.blobs.get(artifact.hash));
    f.remote.setOwner({ ...before, generation: before.generation + 1 });
    await assert.rejects(f.rpc(request), /registration generation/);
    assert.equal(f.remote.owner(lineage).state, 'owned'); f.remote.setOwner(before);
    const captured = await f.rpc(request) as { digest: string };
    assert.equal(f.remote.owner(lineage).state, 'frozen');
    assert.equal((await f.rpc(request) as { digest: string }).digest, captured.digest, 'Duplicate capture returns exact checkpoint');
    assert.equal(f.remote.owner(lineage).transferId, route.reverseId);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const lost of ['capture', 'fence'] as const) test(`return recovery: lost ${lost} acknowledgment retains ID and requires positive exact fence`, async () => {
  const f = await returnFixture();
  try {
    const route = beginReturn(f.store, f.captured.manifest.transferId, f.alias, f.destination); let once = true;
    const losing: Rpc = async request => { const result = await f.rpc(request); if (request.operation === lost && once) { once = false; throw new Error(`lost ${lost} acknowledgment`); } return result; };
    await assert.rejects(resumeReturn(f.store, route, losing, approve(f.store)), /lost .* acknowledgment/);
    assert.equal(f.store.owner(f.captured.manifest.lineageId).state, 'fenced');
    assert.equal(f.remote.owner(f.captured.manifest.lineageId).transferId, route.reverseId);
    const reg = await recover(route.reverseId, false, new Store(f.store.root), { config: f.config, connect: () => f.rpc, approvalDigest: f.remote.manifest(route.reverseId).digest });
    assert.ok(reg && 'sessionFile' in reg); assert.equal(f.store.status(route.reverseId).phase, 'returned');
    assert.equal(f.launches(), 1, 'Return/recovery never starts another runtime');
    assert.equal(readFileSync(join(f.repo, 'newer-local.txt'), 'utf8'), 'do not overwrite newer original edits');
    assert.equal(readFileSync(join(reg.cwd, 'remote-result.txt'), 'utf8'), 'native remote result');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const point of ['capture', 'restoration', 'fence', 'claim', 'registration', 'returned', 'finish'] satisfies ReturnBoundary[]) test(`return recovery: interruption after durable ${point}`, async () => {
  const f = await returnFixture();
  try {
    const route = beginReturn(f.store, f.captured.manifest.transferId, f.alias, f.destination); let once = true;
    await assert.rejects(resumeReturn(f.store, route, f.rpc, approve(f.store), reached => { if (reached === point && once) { once = false; throw new Error(`crash after ${point}`); } }), /crash after/);
    const completed = await resumeReturn(new Store(f.store.root), route, f.rpc, approve(f.store));
    const nativeBefore = readFileSync(completed.sessionFile); const registrationBefore = f.store.registration(completed.sessionFile);
    const again = await pull(f.captured.manifest.transferId, undefined, f.store, { config: f.config, connect: () => f.rpc });
    assert.deepEqual(again, registrationBefore); assert.deepEqual(readFileSync(completed.sessionFile), nativeBefore);
    assert.equal(f.store.status(route.reverseId).phase, 'returned'); assert.equal(f.launches(), 1);
    assert.equal(f.remote.owner(completed.lineageId).state, 'fenced');
    assert.equal(f.store.owner(completed.lineageId).generation, f.captured.manifest.generation + 1);
    assert.equal(readFileSync(join(f.repo, 'newer-local.txt'), 'utf8'), 'do not overwrite newer original edits');
    assert.equal(readFileSync(join(completed.cwd, 'remote-result.txt'), 'utf8'), 'native remote result');
    // Completed retries must not replace subsequently opened registration metadata.
    const opened = { ...registrationBefore, cleanShutdown: false, nonce: randomUUID(), sessionHash: null }; f.store.register(opened);
    await resumeReturn(f.store, route, f.rpc, approve(f.store)); assert.deepEqual(f.store.registration(completed.sessionFile), opened);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('return recovery: partial roots, changed restoration and mismatched fencing proof fail closed', async () => {
  const f = await returnFixture();
  try {
    const route = beginReturn(f.store, f.captured.manifest.transferId, f.alias, f.destination);
    await assert.rejects(resumeReturn(f.store, route, f.rpc, approve(f.store), point => { if (point === 'capture') throw new Error('stop before restoration'); }), /stop before/);
    const root = join(f.store.root, 'runs', route.reverseId); mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'preserve-me'), 'partial');
    await assert.rejects(resumeReturn(f.store, route, f.rpc, approve(f.store)), /Partial restoration/);
    assert.equal(readFileSync(join(root, 'preserve-me'), 'utf8'), 'partial');
    assert.equal(f.remote.owner(f.captured.manifest.lineageId).state, 'frozen');
    // Explicit test cleanup of its own partial fixture, never production recovery cleanup.
    rmSync(root, { recursive: true });
    const forged: Rpc = async request => { const value = await f.rpc(request); return request.operation === 'fence' ? { ...value as object, generation: 999 } : value; };
    await assert.rejects(resumeReturn(f.store, route, forged, approve(f.store)), /fence receipt mismatch/);
    assert.equal(f.store.owner(f.captured.manifest.lineageId).state, 'fenced');
    writeFileSync(join(root, 'workspace', 'worktree', 'changed-after-restore'), 'external edit');
    await assert.rejects(resumeReturn(f.store, route, f.rpc, approve(f.store)), /Restored workspace changed/);
    assert.equal(f.store.owner(f.captured.manifest.lineageId).state, 'fenced');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('return finalization rejects a later owner and a concurrent destination revocation', async () => {
  for (const mode of ['owner', 'revoke'] as const) {
    const f = await returnFixture();
    try {
      const route = beginReturn(f.store, f.captured.manifest.transferId, f.alias, f.destination);
      const originalOwner = f.store.owner(f.captured.manifest.lineageId);
      const interfering: Rpc = async request => {
        const result = await f.rpc(request);
        if (request.operation === 'fence') {
          if (mode === 'owner') f.store.setOwner({ ...originalOwner, transferId: randomUUID(), generation: originalOwner.generation + 10 });
          else f.store.revoke(route.reverseId);
        }
        return result;
      };
      await assert.rejects(resumeReturn(f.store, route, interfering, approve(f.store)), /ownership changed|terminal|cancelled/);
      assert.notEqual(f.store.owner(f.captured.manifest.lineageId).transferId, route.reverseId);
      assert.equal(existsSync(join(f.store.transfer(route.reverseId), 'return-registration.json')), false);
      assert.equal(f.launches(), 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('return recovery never overwrites registration opened between registration and returned status', async () => {
  const f = await returnFixture();
  try {
    const route = beginReturn(f.store, f.captured.manifest.transferId, f.alias, f.destination);
    await assert.rejects(resumeReturn(f.store, route, f.rpc, approve(f.store), point => { if (point === 'registration') throw new Error('interrupted before status'); }), /interrupted/);
    const receipt = JSON.parse(readFileSync(join(f.store.transfer(route.reverseId), 'return-registration.json'), 'utf8'));
    const opened = { ...f.store.registration(receipt.sessionFile), cleanShutdown: false, nonce: randomUUID() }; f.store.register(opened);
    await assert.rejects(resumeReturn(f.store, route, f.rpc, approve(f.store)), /subsequently opened/);
    assert.deepEqual(f.store.registration(receipt.sessionFile), opened); assert.equal(f.launches(), 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('return recovery retries lost finish acknowledgment separately, with no capture, prompt or launch', async () => {
  const f = await returnFixture();
  try {
    const route = beginReturn(f.store, f.captured.manifest.transferId, f.alias, f.destination);
    const losing: Rpc = async request => { const result = await f.rpc(request); if (request.operation === 'finish') throw new Error('lost finish acknowledgment'); return result; };
    await assert.rejects(resumeReturn(f.store, route, losing, approve(f.store)), /lost finish/);
    assert.equal(f.store.status(route.reverseId).phase, 'returned');
    const calls: string[] = []; const retry: Rpc = request => { calls.push(request.operation); return f.rpc(request); };
    await recover(route.reverseId, false, f.store, { config: f.config, connect: () => retry });
    assert.deepEqual(calls, ['finish']); assert.equal(f.launches(), 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
