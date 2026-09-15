import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fixtureRoot, fixtureRepo, fixtureProfile, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { createManaged } from '../src/pi/runtime.js';
import { captureLive } from '../src/commands.js';
import { captureObservation } from '../src/capture-intent.js';

for (const mode of ['write-failure', 'missing', 'lost-ack']) test(`send capture intent: ${mode}, exact ID and JSON stderr redaction`, async () => {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root); const native = fixtureSession(repo, root); const store = new Store(join(root, 'state'));
  const managed = await createManaged({ store, profilePath: profile.path, cwd: repo, manager: native.manager, allowTest: true });
  const config = join(root, 'config.json'); const destination = join(root, 'remote'); const instruction = join(root, 'instruction.txt'); const secret = 'literal sensitive instruction must not leak'; writeFileSync(instruction, secret);
  writeFileSync(config, JSON.stringify({ version: 1, profile: profile.path, localRoot: store.root, remoteRoot: destination, defaultHost: 'remote', hosts: { remote: { root: destination, profileDigest: managed.registration.profileDigest } } }));
  const capture = mode === 'lost-ack'; let calls = 0; let admittedId = '';
  const server = createServer(socket => { socket.on('error', () => {}); socket.once('data', async bytes => {
    calls++; const request = JSON.parse(bytes.toString()); admittedId = request.id;
    assert.ok(existsSync(join(store.root, 'capture-intents', admittedId + '.json')), 'intent is durable before admission');
    if (capture) await captureLive(managed, store, { destination: request.destination, targetRoot: request.targetRoot, instruction: request.instruction, transferId: request.id });
    socket.destroy(); // Never send an ACK, including after successful durable capture.
  }); });
  await new Promise<void>(ok => server.listen(managed.registration.socket, ok));
  const invoke = async (...args: string[]) => {
    const child = spawn(process.execPath, [resolve('dist/src/cli.js'), ...args], { env: { ...process.env, BAUBLE_CONFIG: config, BAUBLE_STATE: store.root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); const [code] = await once(child, 'close'); return { code, stdout, stderr };
  };
  const send = () => invoke('send', '--session', managed.registration.sessionId, '--instruction-file', instruction, '--prepare', '--quiet', '--json');
  try {
    if (mode === 'write-failure') {
      writeFileSync(join(store.root, 'capture-intents'), 'block directory creation');
      const failed = await send(); assert.equal(failed.code, 1); assert.equal(calls, 0); assert.equal(managed.guard.phase, 'open'); return;
    }
    const lost = await send(); assert.equal(lost.code, 1); assert.equal(calls, 1); const id = admittedId;
    assert.ok(lost.stderr.includes(id)); assert.ok(!lost.stderr.includes(secret)); assert.ok(!lost.stdout.includes(secret));
    if (mode === 'missing') {
      const observed = await invoke('status', id, '--json'); assert.equal(observed.code, 0); const data = JSON.parse(observed.stdout).data;
      assert.equal(data.observation, 'capture-intent'); assert.equal(data.checkpoint, 'missing'); assert.equal(data.recordedRegistration.sessionId, managed.registration.sessionId); assert.equal(data.intent.source.lineageId, managed.registration.lineageId);
      const recovery = await invoke('recover', id, '--json'); assert.equal(recovery.code, 4); assert.equal(JSON.parse(recovery.stdout).error.code, 'CAPTURE_UNCERTAIN'); assert.equal(calls, 1);
      const duplicate = await send(); assert.equal(duplicate.code, 4); assert.equal(JSON.parse(duplicate.stdout).data.transferId, id); assert.equal(calls, 1, 'unresolved intent must not be recaptured with a new ID');
      mkdirSync(store.transfer(id), { recursive: true }); writeFileSync(join(store.transfer(id), 'manifest.json'), '{broken');
      const partial = await invoke('status', id, '--json'); assert.equal(partial.code, 0); assert.equal(JSON.parse(partial.stdout).data.checkpoint, 'partial-or-invalid');
    } else {
      assert.equal(store.owner(managed.registration.lineageId).state, 'frozen'); assert.equal(store.owner(managed.registration.lineageId).transferId, id);
      assert.equal(store.manifest(id).manifest.instruction, secret); assert.equal(captureObservation(store, id)!.checkpoint, 'complete');
      const status = await invoke('status', id, '--json'); assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).data.transferId, id);
    }
    assert.equal(readdirSync(join(store.root, 'capture-intents')).length, 1); assert.ok(!readFileSync(join(store.root, 'capture-intents', id + '.json'), 'utf8').includes(secret));
  } finally { server.close(); await managed.close(); rmSync(root, { recursive: true, force: true }); }
});
