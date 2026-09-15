import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { fixtureRoot, fixtureRepo, fixtureProfile, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { createManaged } from '../src/pi/runtime.js';
import { captureLive } from '../src/commands.js';
import { captureOffline } from '../src/checkpoint.js';

test('capture rollback retains freeze when immutable checkpoint was published before binding write failed', async () => {
  for (const liveCapture of [true, false]) {
    const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root); const session = fixtureSession(repo, root); const store = new Store(join(root, 'state'));
    const live = await createManaged({ store, profilePath: profile.path, cwd: repo, manager: session.manager, allowTest: true });
    const id = randomUUID(); const setOwner = store.setOwner.bind(store);
    try {
      if (!liveCapture) await live.close();
      store.setOwner = owner => { if (owner.transferId === id) throw new Error('checkpoint binding write failure'); setOwner(owner); };
      const options = { transferId: id, destination: 'fixture-destination', targetRoot: join(root, 'destination') };
      if (liveCapture) await assert.rejects(captureLive(live, store, options), /checkpoint binding write failure/);
      else assert.throws(() => captureOffline({ ...options, store, registration: store.registration(live.registration.sessionId) }), /checkpoint binding write failure/);
      assert.ok(existsSync(join(store.transfer(id), 'manifest.json')));
      assert.equal(store.owner(live.registration.lineageId).state, 'frozen');
      if (liveCapture) { assert.equal(live.guard.phase, 'frozen'); assert.throws(() => live.runtime.session.prompt('new input'), /frozen/); }
    } finally { store.setOwner = setOwner; await live.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
