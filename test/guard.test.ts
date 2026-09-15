import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { fixtureRoot, fixtureProfile, fixtureRepo, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { createManaged } from '../src/pi/runtime.js';

test('guard: real Pi routes reject frozen input, bash, tools, settings, model/thinking, tree, reload and replacement', async () => {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root); const source = fixtureSession(repo, root); const store = new Store(join(root, 'state'));
  const managed = await createManaged({ store, profilePath: profile.path, cwd: repo, manager: source.manager, allowTest: true }); const session = managed.runtime.session;
  await session.bindExtensions({ mode: 'print' }); await managed.settled(); const bytes = readFileSync(session.sessionFile!);
  for (const attempt of [() => session.prompt('must not run'), () => session.executeBash('touch forbidden'), () => session.setThinkingLevel('high'), () => session.setModel(session.model!), () => session.cycleModel(), () => session.setSessionName('changed'), () => session.navigateTree(source.leaf), () => session.reload(), () => session.sessionManager.branch(source.leaf), () => session.sessionManager.appendCustomEntry('bauble:unexpected'), () => session.settingsManager.setCompactionEnabled(true)]) assert.throws(attempt, /frozen|freeze/);
  await assert.rejects(managed.runtime.newSession(), /frozen|freeze/);
  assert.equal((await session.extensionRunner.emitInput('blocked', undefined, 'interactive')).action, 'handled');
  assert.equal((await session.extensionRunner.emitUserBash({ type: 'user_bash', command: 'touch forbidden', cwd: repo, excludeFromContext: false }))?.result?.cancelled, true);
  assert.ok(readFileSync(session.sessionFile!).equals(bytes));
  managed.guard.unfreeze();
  const ownerPath = store.ownerPath(managed.registration.lineageId); renameSync(ownerPath, ownerPath + '.missing');
  assert.throws(() => session.prompt('storage failure'), /ENOENT/);
  assert.equal((await session.extensionRunner.emitInput('blocked storage', undefined, 'interactive')).action, 'handled');
  renameSync(ownerPath + '.missing', ownerPath);
  await managed.close(); rmSync(root, { recursive: true, force: true });
});

test('guard settlement waits for accepted user bash while rejecting new work', async () => {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root); const source = fixtureSession(repo, root); const store = new Store(join(root, 'state'));
  const managed = await createManaged({ store, profilePath: profile.path, cwd: repo, manager: source.manager, allowTest: true }); const session = managed.runtime.session;
  await session.bindExtensions({ mode: 'print' });
  const bash = session.executeBash('sleep 0.15; printf settled');
  const settling = managed.settled();
  assert.throws(() => session.prompt('not accepted'), /frozen/);
  await bash; await settling;
  assert.ok(session.sessionManager.getEntries().some(e => e.type === 'message' && e.message.role === 'bashExecution' && e.message.output === 'settled'));
  await managed.close(); rmSync(root, { recursive: true, force: true });
});
