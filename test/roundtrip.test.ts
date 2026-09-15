import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager, buildSessionContext } from '@earendil-works/pi-coding-agent';
import { fixtureRoot, fixtureProfile, fixtureRepo, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { captureWorkspace, restoreWorkspace, inventory } from '../src/workspace.js';
import { captureNative, restoreNative, validateSession } from '../src/pi/native.js';
import { createManaged } from '../src/pi/runtime.js';
import { fixtureContexts } from '../src/pi/fixture.js';
import { run, json, hash, atomicWrite } from '../src/safe.js';

test('roundtrip: native full tree/non-last leaf, real provider/tool run, exact dirty workspace, isolated return', async () => {
  const root = fixtureRoot(); const { path: profilePath, profile } = fixtureProfile(root); const repo = fixtureRepo(root); const store = new Store(join(root, 'state'));
  const source = fixtureSession(repo, root); const originalBytes = readFileSync(source.manager.getSessionFile()!); const originalIndex = readFileSync(join(repo, '.git/index'));
  const initial = inventory(repo, store.blobs); const checkpoint = captureWorkspace(repo, store.blobs);
  assert.ok(checkpoint.workspace.excluded.some(f => f.path === '.env')); assert.notEqual(checkpoint.workspace.index.find(f => f.path === 'staged.txt')!.hash, checkpoint.workspace.files.find(f => f.path === 'staged.txt')!.hash);
  const live = await createManaged({ store, profilePath, cwd: repo, manager: source.manager, allowTest: true });
  const reg = await live.settled(); const native = captureNative(reg, profile, store.blobs, live.runtime.session);
  assert.equal(native.leaf, source.leaf); assert.equal(native.artifacts.length, 1); assert.ok(store.blobs.get(native.session).equals(originalBytes));
  await live.close();
  const remote = restoreWorkspace(checkpoint.workspace, store.blobs, join(root, 'remote-workspace'));
  assert.deepEqual(inventory(remote, store.blobs).files, checkpoint.workspace.files); assert.equal(existsSync(join(remote, '.env')), false);
  const restored = restoreNative(native, store.blobs, remote, join(root, 'remote-native'), randomUUID());
  assert.deepEqual(restored.manager.getEntries().slice(0, -1), JSON.parse(json(source.manager.getEntries())));
  assert.equal(restored.manager.getEntry(restored.restoredLeaf)!.parentId, source.leaf);
  assert.deepEqual(restored.manager.buildSessionContext().messages.slice(0, -1), buildSessionContext(source.manager.getEntries(), source.leaf).messages);
  const restart = run(process.execPath, ['--input-type=module', '-e', 'import {SessionManager} from "@earendil-works/pi-coding-agent"; const s=SessionManager.open(process.argv[1]);console.log(JSON.stringify({leaf:s.getLeafId(),context:s.buildSessionContext()}))', restored.file]);
  assert.deepEqual(JSON.parse(restart.toString()), JSON.parse(json({ leaf: restored.restoredLeaf, context: restored.manager.buildSessionContext() })));
  const remoteStore = new Store(join(root, 'remote-state'));
  const remoteLive = await createManaged({ store: remoteStore, profilePath, cwd: remote, manager: restored.manager, allowTest: true });
  const events: string[] = []; remoteLive.runtime.session.subscribe(e => events.push(e.type));
  await remoteLive.runtime.session.bindExtensions({ mode: 'print' });
  const before = structuredClone(remoteLive.runtime.session.messages); fixtureContexts.length = 0;
  await remoteLive.runtime.session.prompt('fixture:write {"path":"roundtrip.txt","content":"native Pi tool output\\n"}', { expandPromptTemplates: false });
  await remoteLive.runtime.session.waitForIdle();
  assert.equal(readFileSync(join(remote, 'roundtrip.txt'), 'utf8'), 'native Pi tool output\n'); assert.ok(events.includes('tool_execution_end')); assert.ok(events.includes('agent_settled'));
  assert.equal(fixtureContexts.length, 2); assert.ok(JSON.stringify(fixtureContexts[0]!.messages).includes('Native persisted compaction summary')); assert.ok(JSON.stringify(fixtureContexts[0]!.messages).includes('bauble:relocation') || JSON.stringify(fixtureContexts[0]!.messages).includes('Historical prose'));
  unlinkSync(source.artifact); // The other machine cannot rely on the original artifact path.
  const remoteReg = await remoteLive.settled(); const reverseNative = captureNative(remoteReg, profile, remoteStore.blobs, remoteLive.runtime.session); const reverseWork = captureWorkspace(remote, remoteStore.blobs);
  await remoteLive.close();
  writeFileSync(join(repo, 'staged.txt'), 'newer original edit — must survive\n');
  const returned = restoreWorkspace(reverseWork.workspace, remoteStore.blobs, join(root, 'return-workspace')); const returnedSession = restoreNative(reverseNative, remoteStore.blobs, returned, join(root, 'return-native'), randomUUID());
  assert.equal(readFileSync(join(returned, 'roundtrip.txt'), 'utf8'), 'native Pi tool output\n'); assert.equal(readFileSync(join(repo, 'staged.txt'), 'utf8'), 'newer original edit — must survive\n');
  assert.ok(readFileSync(join(repo, '.git/index')).equals(originalIndex)); assert.ok(readFileSync(source.manager.getSessionFile()!).equals(originalBytes));
  assert.equal(returnedSession.manager.getEntries().length, restored.manager.getEntries().length + 1);
  rmSync(root, { recursive: true, force: true });
});

test('pinned Pi 0.85.1 lacks documented retainedTail support: reject before migration', () => {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const fixture = fixtureSession(repo, root);
  const lines = readFileSync(fixture.manager.getSessionFile()!, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  const compaction = lines.find(e => e.type === 'compaction'); delete compaction.firstKeptEntryId; compaction.retainedTail = [{ role: 'user', content: 'must not be lost', timestamp: 1 }];
  const bytes = Buffer.from(lines.map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(JSON.stringify(buildSessionContext(lines.slice(1), fixture.leaf)).includes('must not be lost'), false, 'This regression documents the actual native builder limitation');
  assert.throws(() => validateSession(bytes, fixture.leaf, true), /retainedTail/); rmSync(root, { recursive: true, force: true });
});
