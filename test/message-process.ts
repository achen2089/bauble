// Separate native runtime/process used by message.test.ts to race store-global UUID admission.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { fixtureRoot, fixtureProfile, fixtureRepo, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { createManaged } from '../src/pi/runtime.js';
import { captureCheckpoint } from '../src/checkpoint.js';
import { handleRequest, prepareRestore, sendCheckpoint } from '../src/protocol.js';
import { internalRuntime } from '../src/commands.js';
import { acceptMessage } from '../src/message.js';
import { hash } from '../src/safe.js';

const remoteRoot = process.argv[2]!;
const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root);
const native = fixtureSession(repo, root); const source = new Store(join(root, 'source'));
const original = await createManaged({ store: source, profilePath: profile.path, cwd: repo, manager: native.manager, allowTest: true });
const reg = await original.settled();
const config = { version: 1 as const, hosts: { destination: { root: remoteRoot, profileDigest: reg.profileDigest } }, profile: profile.path, localRoot: source.root, remoteRoot: dirname(dirname(remoteRoot)) };
const checkpoint = captureCheckpoint({ store: source, registration: reg, profile: profile.profile, destination: 'destination', targetRoot: remoteRoot, live: original.runtime.session });
const id = checkpoint.manifest.transferId; source.approve(id, checkpoint.digest);
let managed!: Awaited<ReturnType<typeof internalRuntime>>;
await sendCheckpoint(source, id, request => handleRequest(request, { config, allowFixture: true, launch: async (store, id) => { prepareRestore(store, id); managed = await internalRuntime(id, store.root, false); } }), remoteRoot);
const remote = new Store(remoteRoot); const receipt = remote.status(id).receipt!;
process.send!({ type: 'ready', id });
process.on('message', async (raw: { operation: string; requestId: string; hold?: string }) => {
  if (raw.operation === 'close') {
    await managed.close(); await original.close(); fs.rmSync(root, { recursive: true, force: true }); process.disconnect(); return;
  }
  const open = fs.openSync;
  if (raw.hold) {
    let blocked = false;
    fs.openSync = ((path, ...args) => {
      if (!blocked && String(path).startsWith(join(remoteRoot, 'message-inbox', raw.requestId + '.json.'))) {
        blocked = true;
        process.send!({ type: 'blocked' });
        const deadline = Date.now() + 20000;
        while (!fs.existsSync(raw.hold!)) {
          if (Date.now() > deadline) throw new Error('Admission barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return open(path, ...args);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
  }
  try {
    const text = 'cross-process UUID admission';
    const result = await acceptMessage(managed, remote, { requestId: raw.requestId, receipt, text, textDigest: hash(text) });
    await Promise.all([...managed.guard.pending]); await managed.runtime.session.waitForIdle();
    const count = managed.runtime.session.sessionManager.getEntries().filter(e => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e.message.content).includes(text)).length;
    process.send!({ type: 'result', state: result.state, count, id });
  } catch (error) { process.send!({ type: 'result', error: String(error), id }); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
});
