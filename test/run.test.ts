import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { existsSync, realpathSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fixtureRoot, fixtureProfile, fixtureRepo } from './fixtures.js';
import { Store } from '../src/store.js';
import { atomicWrite, json, run, hash } from '../src/safe.js';
import { snapshotProfile } from '../src/pi/profile.js';
import { captureTask, dispatchTask, verifyTaskSource } from '../src/run.js';
import { handleRequest, stage } from '../src/protocol.js';
import { folderInventory } from '../src/folder.js';
import { validateCodeRoot } from '../src/hosts.js';
import { internalRuntime, recover } from '../src/commands.js';
import { inventory, validateInventory } from '../src/workspace.js';
import { beginReturn, resumeReturn } from '../src/return.js';
import { messageSession } from '../src/message.js';
import { openSession } from '../src/open.js';
import { prepareFresh } from '../src/fresh.js';
import type { Config } from '../src/schema.js';
import type { Rpc } from '../src/transport.js';

function fixture(git = false) {
  const root = realpathSync(fixtureRoot()); const profile = fixtureProfile(root); const source = new Store(join(root, 'state'));
  const cwd = git ? fixtureRepo(root) : join(root, 'plain'); if (!git) { mkdirSync(cwd); writeFileSync(join(cwd, 'bytes.bin'), Buffer.from([0, 255, 10])); writeFileSync(join(cwd, 'keep.txt'), 'original'); chmodSync(join(cwd, 'keep.txt'), 0o755); symlinkSync('keep.txt', join(cwd, 'link')); writeFileSync(join(cwd, '.gitignore'), 'ignored/\n'); mkdirSync(join(cwd, 'ignored')); writeFileSync(join(cwd, 'ignored', 'private'), 'excluded'); mkdirSync(join(cwd, 'node_modules')); writeFileSync(join(cwd, 'node_modules', 'large'), 'excluded'); }
  const digest = snapshotProfile(profile.profile, root, source.blobs).digest; const remoteRoot = join(root, 'destination', 'fixtures', randomUUID()); const remote = new Store(remoteRoot);
  const config: Config = { version: 1, hosts: { remote: { root: remoteRoot, profileDigest: digest } }, defaultHost: 'remote', profile: profile.path, localRoot: source.root, remoteRoot: join(root, 'destination') };
  return { root, profile, source, cwd, digest, remoteRoot, remote, config, target: { alias: 'remote', root: remoteRoot, profile: profile.path, profileDigest: digest } };
}

for (const git of [false, true]) test(`run: fresh native ${git ? 'dirty Git' : 'plain folder'} tool task, no seed, lost ACK no replay, messages and separate result pull`, async t => {
  const f = fixture(git); const previous = process.env.BAUBLE_TEST_MODE; process.env.BAUBLE_TEST_MODE = '1';
  let managed: Awaited<ReturnType<typeof internalRuntime>> | undefined; let launches = 0;
  t.after(async () => { await managed?.close(); if (previous === undefined) delete process.env.BAUBLE_TEST_MODE; else process.env.BAUBLE_TEST_MODE = previous; rmSync(f.root, { recursive: true, force: true }); });
  const before = inventory(f.cwd, f.source.blobs); const index = git ? readFileSync(join(f.cwd, '.git', 'index')) : undefined;
  const task = await captureTask({ cwd: f.cwd, prompt: 'fixture:write {"path":"result.txt","content":"native result"}', name: 'test-job' }, f.source, f.target); const id = task.manifest.transferId;
  assert.equal(task.manifest.native.session, null); assert.equal(task.manifest.native.sessionId, null); assert.equal(task.manifest.parentTransfer, null);
  assert.equal(existsSync(join(f.source.root, 'sessions')), false); assert.equal(existsSync(join(f.source.root, 'native-sessions')), false); assert.equal(existsSync(f.source.ownerPath(task.manifest.lineageId)), false);
  f.source.approve(id, task.digest);
  const rpc: Rpc = request => handleRequest(request, { config: f.config, allowFixture: true, launch: async (store, id) => { launches++; prepareFresh(store, id); assert.equal(existsSync(join(store.root, 'runs', id, 'native')), false); managed = await internalRuntime(id, store.root, false); } });
  const lost: Rpc = async request => { const result = await rpc(request); if (request.operation === 'activate') throw new Error('lost launch ACK'); return result; };
  await assert.rejects(dispatchTask(f.source, id, lost, f.remoteRoot), { code: 'AUTHORITY_UNCERTAIN' });
  await dispatchTask(f.source, id, rpc, f.remoteRoot); await rpc({ operation: 'activate', root: f.remoteRoot, data: { id, digest: task.digest } });
  assert.equal(launches, 1); assert.equal(f.remote.status(id).continuation, 'accepted'); assert.equal(f.source.owner(task.manifest.lineageId).state, 'dispatched');
  assert.equal(readFileSync(join(task.manifest.target.cwd, 'result.txt'), 'utf8'), 'native result');
  const entries = managed!.runtime.session.sessionManager.getEntries(); assert.equal(entries.filter(e => e.type === 'message' && e.message.role === 'user').length, 1); assert.ok(!managed!.runtime.session.sessionManager.getHeader()?.parentSession);
  if (!git) assert.equal(existsSync(join(task.manifest.target.cwd, '.git')), false);
  const message = await messageSession(id, '/bauble literal fresh followup', randomUUID(), f.source, { config: f.config, connect: () => rpc }); assert.equal(message.state, 'accepted');
  await Promise.all([...managed!.guard.pending]); await managed!.runtime.session.waitForIdle();
  assert.ok(managed!.runtime.session.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('/bauble literal fresh followup')));
  assert.deepEqual(inventory(f.cwd, f.source.blobs), before); if (index) assert.deepEqual(readFileSync(join(f.cwd, '.git', 'index')), index);
  // Return after closing exact test runtime: no live user session involved.
  await managed!.close();
  const route = beginReturn(f.source, id, 'remote', f.remoteRoot);
  const reg = await resumeReturn(f.source, route, rpc, async reverse => { f.source.approve(reverse, f.source.manifest(reverse).digest); });
  assert.equal(readFileSync(join(reg.cwd, 'result.txt'), 'utf8'), 'native result'); assert.notEqual(reg.cwd, f.cwd); assert.equal(existsSync(join(f.cwd, 'result.txt')), false);
  if (!git) assert.equal(existsSync(join(reg.cwd, '.git')), false);
  assert.deepEqual(inventory(f.cwd, f.source.blobs), before);
});

test('run: literal task/context snapshots, changed source, paths, secrets and unsupported folders fail closed', async t => {
  const f = fixture(); const previous = process.env.BAUBLE_TEST_MODE; process.env.BAUBLE_TEST_MODE = '1'; t.after(() => { if (previous === undefined) delete process.env.BAUBLE_TEST_MODE; else process.env.BAUBLE_TEST_MODE = previous; rmSync(f.root, { recursive: true, force: true }); });
  const taskFile = join(f.root, 'TASK.md'); const context = join(f.root, 'CONTEXT.md'); const text = '---\nhooks: $(touch NEVER)\n---\n/bauble !command'; writeFileSync(taskFile, text); writeFileSync(context, '/skill:literal `not executed`');
  const captured = await captureTask({ cwd: f.cwd, task: taskFile, context: [context] }, f.source, f.target);
  assert.equal(captured.manifest.inputs!.length, 2); assert.ok(captured.manifest.instruction!.startsWith(text)); assert.ok(captured.manifest.instruction!.includes('/skill:literal `not executed`'));
  f.source.approve(captured.manifest.transferId, captured.digest); let literalRuntime: Awaited<ReturnType<typeof internalRuntime>> | undefined;
  try { await dispatchTask(f.source, captured.manifest.transferId, request => handleRequest(request, { config: f.config, allowFixture: true, launch: async (store, id) => { literalRuntime = await internalRuntime(id, store.root, false); } }), f.remoteRoot); const users = literalRuntime!.runtime.session.messages.filter(m => m.role === 'user'); assert.equal(users.length, 1); assert.equal(JSON.stringify(users[0]!.content).includes('hooks: $(touch NEVER)'), true); assert.equal(existsSync(join(captured.manifest.target.cwd, 'NEVER')), false); } finally { await literalRuntime?.close(); }
  writeFileSync(context, 'changed'); assert.throws(() => verifyTaskSource(f.source, captured.manifest.transferId), /changed/);
  const key = join(f.root, 'auth.json'); writeFileSync(key, 'credential'); await assert.rejects(captureTask({ cwd: f.cwd, task: key }, f.source, f.target), /Sensitive/);
  symlinkSync('../TASK.md', join(f.cwd, 'escape')); await assert.rejects(captureTask({ cwd: f.cwd, prompt: 'text' }, f.source, f.target), /Escaping symlink/); unlinkSync(join(f.cwd, 'escape'));
  assert.throws(() => validateInventory([{ path: 'keep.txt', type: 'file', mode: '100644', hash: hash('a') }, { path: 'KEEP.TXT', type: 'file', mode: '100644', hash: hash('b') }]), /colliding/);
  writeFileSync(join(f.cwd, 'credentials.json'), 'secret'); await assert.rejects(captureTask({ cwd: f.cwd, prompt: 'text', autoApprove: true }, f.source, f.target), /credential/);
});

test('run: sensitive workspace roots and ancestors reject before approval or staging', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const before = f.source.list();
  for (const path of ['secrets', 'secrets/nested', 'secret', '.env.private', 'keys.pem/nested']) {
    const cwd = join(f.cwd, path); mkdirSync(cwd, { recursive: true }); writeFileSync(join(cwd, 'token.txt'), 'not transferable');
    await assert.rejects(captureTask({ cwd, prompt: 'review', autoApprove: true }, f.source, f.target), /Sensitive/);
    assert.deepEqual(f.source.list(), before); assert.equal(f.remote.list().length, 0);
  }
});

test('folder: nested ignore negations match Git precedence without traversing excluded directories', t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  unlinkSync(join(f.cwd, 'link')); writeFileSync(join(f.cwd, '.gitignore'), '*.txt\nblocked/\n');
  mkdirSync(join(f.cwd, 'sub', 'deep'), { recursive: true }); mkdirSync(join(f.cwd, 'blocked'));
  writeFileSync(join(f.cwd, 'sub', '.gitignore'), '!keep.txt\n');
  writeFileSync(join(f.cwd, 'sub', 'deep', '.gitignore'), 'keep.txt\n!other.txt\n');
  writeFileSync(join(f.cwd, 'blocked', '.gitignore'), '!keep.txt\n');
  const paths = ['sub/keep.txt', 'sub/drop.txt', 'sub/deep/keep.txt', 'sub/deep/other.txt', 'blocked/keep.txt'];
  for (const path of paths) writeFileSync(join(f.cwd, path), path);
  const captured = folderInventory(f.cwd, f.source.blobs);
  run('git', ['init', '--template=', f.cwd]);
  for (const path of paths) {
    const result = spawnSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '-q', path], { cwd: f.cwd });
    assert.ok(result.status === 0 || result.status === 1); assert.equal(captured.files.some(file => file.path === path), result.status === 1, path);
  }
  assert.ok(captured.files.some(file => file.path === 'sub/keep.txt'));
  assert.ok(captured.excluded.some(file => file.path === 'blocked'));
  assert.ok(!captured.excluded.some(file => file.path.startsWith('blocked/')));
});

test('run: codeRoot safety is rechecked at probe, ready, activation and prepared reuse', async t => {
  const f = fixture(); const previous = process.env.BAUBLE_TEST_MODE; process.env.BAUBLE_TEST_MODE = '1';
  t.after(() => { if (previous === undefined) delete process.env.BAUBLE_TEST_MODE; else process.env.BAUBLE_TEST_MODE = previous; rmSync(f.root, { recursive: true, force: true }); });
  const codeRoot = join(f.root, 'code'); mkdirSync(codeRoot, { mode: 0o700 }); validateCodeRoot(codeRoot, f.remoteRoot); f.config.codeRoot = codeRoot;
  const job = await captureTask({ cwd: f.cwd, prompt: 'review' }, f.source, { ...f.target, codeRoot }); const id = job.manifest.transferId;
  f.source.approve(id, job.digest); let launches = 0;
  const rpc: Rpc = request => handleRequest(request, { config: f.config, allowFixture: true, launch: async () => { launches++; } });
  await stage(f.source, id, rpc, f.remoteRoot);
  chmodSync(codeRoot, 0o777);
  for (const operation of ['probe', 'ready', 'activate'] as const) await assert.rejects(rpc({ operation, root: f.remoteRoot, data: { id, digest: job.digest } }), /not group\/world writable/);
  assert.throws(() => prepareFresh(f.remote, id), /not group\/world writable/);
  assert.equal(existsSync(job.manifest.target.repository), false); assert.equal(launches, 0);
  chmodSync(codeRoot, 0o700); prepareFresh(f.remote, id);
  chmodSync(codeRoot, 0o770); assert.throws(() => prepareFresh(f.remote, id), /not group\/world writable/);
  assert.equal(existsSync(join(f.remote.root, 'runs', id, 'native')), false);
  chmodSync(codeRoot, 0o700); prepareFresh(f.remote, id);
  assert.throws(() => validateCodeRoot(codeRoot, join(codeRoot, 'actual-state')), /separate code folder/);
});

test('run CLI: non-TTY refuses default approval; autoapprove starts native tmux, codeRoot/name routing, host defaults, literal input', { timeout: 90000 }, async t => {
  const f = fixture(); const bin = join(f.root, 'bin'); mkdirSync(bin); const codeRoot = join(f.root, 'code'); mkdirSync(codeRoot, { mode: 0o700 });
  f.config.codeRoot = codeRoot; f.config.hosts.remote!.codeRoot = codeRoot;
  const configFile = join(f.root, 'local.json'); const remoteConfig = join(f.root, 'remote.json'); atomicWrite(configFile, json(f.config)); atomicWrite(remoteConfig, json(f.config));
  const cli = resolve('dist/src/cli.js'); const helper = resolve('dist/test/run-helper.js');
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nexec '${process.execPath}' '${helper}' "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'bauble'), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BAUBLE_CONFIG: configFile, BAUBLE_STATE: f.source.root, BAUBLE_TEST_MODE: '1', BAUBLE_TEST_REMOTE_CONFIG: remoteConfig, BAUBLE_TEST_HELPER_COUNT: join(f.root, 'helper-count'), BAUBLE_TEST_REMOTE_ROOT: f.remoteRoot, BAUBLE_TEST_PROFILE_DIGEST: f.digest, PI_OFFLINE: '1' };
  const tokens: string[] = [];
  t.after(async () => { for (const token of tokens) spawnSync('tmux', ['-L', token, 'kill-server']); await new Promise(ok => setTimeout(ok, 500)); rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const helperCount = () => existsSync(env.BAUBLE_TEST_HELPER_COUNT) ? readFileSync(env.BAUBLE_TEST_HELPER_COUNT, 'utf8').trim().split('\n').length : 0;
  const call = (...args: string[]) => { const before = helperCount(); const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 }); assert.ok(helperCount() - before <= 1, `one helper per command: ${args[0]}`); return result; };
  const remoteBefore = readFileSync(remoteConfig); const added = call('host', 'add', 'second', '--default', '--code-root', codeRoot); assert.equal(added.status, 0, added.stderr); assert.equal(JSON.parse(readFileSync(remoteConfig, 'utf8')).remoteRoot, f.config.remoteRoot); const backup = readdirSync(f.root).find(p => p.startsWith('remote.json.') && p.endsWith('.bak'))!; assert.deepEqual(readFileSync(join(f.root, backup)), remoteBefore); assert.ok(call('host', 'list').stdout.includes('defaultHost: second'));  assert.equal(call('host', 'default', 'remote').status, 0);
  const bootstrapFile = join(f.root, 'bootstrap.json'); const bootstrap = spawnSync(process.execPath, [cli, 'host', 'add', 'remote', '--profile', f.profile.path], { env: { ...env, BAUBLE_CONFIG: bootstrapFile }, encoding: 'utf8', timeout: 10000 }); assert.equal(bootstrap.status, 0, bootstrap.stderr); assert.ok(!bootstrap.stdout.includes('effective:')); assert.equal(JSON.parse(readFileSync(bootstrapFile, 'utf8')).profile, f.profile.path);
  const refused = call('run', f.cwd, '--prompt', 'literal /bauble'); assert.equal(refused.status, 3); assert.match(refused.stderr, /APPROVAL_REQUIRED/); assert.equal(f.remote.list().length, 0); assert.equal(existsSync(join(f.source.root, 'sessions')), false);
  const blocked = call('run', f.cwd, '--prompt', 'sensitive-literal-marker', '--json', '--quiet'); assert.equal(blocked.status, 3); const blockedEnvelope = JSON.parse(blocked.stdout); assert.equal(blockedEnvelope.error.code, 'APPROVAL_REQUIRED'); assert.ok(blockedEnvelope.data.transferId); assert.ok(!blocked.stdout.includes('sensitive-literal-marker')); assert.ok(blocked.stderr.includes(blockedEnvelope.data.transferId)); assert.ok(!blocked.stderr.includes('sensitive-literal-marker'));
  const preparedResult = call('run', f.cwd, '--prompt', 'prepared literal task', '--name', 'prepared-job', '--prepare', '--json', '--quiet'); assert.equal(preparedResult.status, 0, preparedResult.stderr); const prepared = JSON.parse(preparedResult.stdout).data; assert.equal(prepared.prepared, true); assert.equal(f.remote.list().length, 0);
  const inspected = call('inspect', prepared.transferId, '--json'); assert.equal(inspected.status, 0); assert.equal(JSON.parse(inspected.stdout).data.manifest.instruction, 'prepared literal task');
  const approved = call('approve', prepared.transferId, '--approval-digest', prepared.digest, '--json'); assert.equal(approved.status, 0); assert.equal(JSON.parse(approved.stdout).data.approved, true); assert.equal(f.remote.list().length, 0);
  const resumed = call('recover', prepared.transferId, '--json', '--quiet'); tokens.push(`b${prepared.transferId.replaceAll('-', '')}`); assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout); assert.equal(JSON.parse(resumed.stdout).data.transferId, prepared.transferId); assert.ok(!resumed.stdout.includes('prepared literal task'));
  const reversePrepared = call('pull', prepared.transferId, '--prepare', '--json', '--quiet'); assert.equal(reversePrepared.status, 0, reversePrepared.stderr + reversePrepared.stdout); const reverse = JSON.parse(reversePrepared.stdout).data; assert.equal(reverse.originalId, prepared.transferId); assert.equal(reverse.remoteFrozen, true);
  assert.equal(call('approve', reverse.reverseId, '--approval-digest', reverse.digest, '--json').status, 0);
  const returned = call('recover', reverse.reverseId, '--json', '--quiet'); assert.equal(returned.status, 0, returned.stderr + returned.stdout); assert.equal(JSON.parse(returned.stdout).data.returned, true);
  const result = call('run', '--cwd', f.cwd, '--prompt', 'fixture:write {"path":"cli-result.txt","content":"CLI native"}', '--auto-approve', '--name', 'cli-job', '--host', 'remote');
  for (const row of f.source.list()) tokens.push(`b${row.transferId.replaceAll('-', '')}`);
  assert.equal(result.status, 0, result.stderr + result.stdout); const job = f.source.list().find(row => row.manifest.name === 'cli-job')!; assert.ok(job.receipt, result.stdout);
  assert.equal(job.manifest.target.repository, join(codeRoot, `cli-job-${job.transferId}`));
  const deadline = Date.now() + 15000; while (!existsSync(join(job.manifest.target.cwd, 'cli-result.txt')) && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 100));
  assert.equal(readFileSync(join(job.manifest.target.cwd, 'cli-result.txt'), 'utf8'), 'CLI native');
  assert.ok(existsSync(join(f.source.transfer(job.transferId), 'autoapproval.json'))); assert.ok(call('ls').stdout.includes(job.transferId));
  const requestId = randomUUID(); const message = call('message', 'cli-job', '/bauble literal followup', '--request-id', requestId); assert.equal(message.status, 0, message.stderr + message.stdout);
  assert.equal(call('message-status', job.transferId, '--request-id', requestId).status, 0);
  const before = readFileSync(join(f.remote.transfer(job.transferId), 'status.json'));
  await openSession(job.transferId, true, f.source, { config: f.config, interactive: true, connect: () => async request => { const out = spawnSync(process.execPath, [helper], { env, input: json(request), encoding: 'utf8', timeout: 10000 }); assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout).data; }, run: async (file, args) => { assert.equal(file, 'ssh'); assert.ok(args.at(-1)!.startsWith('bauble _attach ')); } });
  assert.deepEqual(readFileSync(join(f.remote.transfer(job.transferId), 'status.json')), before);
  assert.equal(existsSync(join(f.cwd, 'cli-result.txt')), false);
  const duplicateName = call('run', f.cwd, '--prompt', 'another intended task', '--name', 'cli-job'); assert.notEqual(duplicateName.status, 0); assert.match(call('open', 'cli-job', '--here').stderr, /ambiguous/);
});

test('run: pre-dispatch changes and lost-before-activation authority never launch or replay', async t => {
  const f = fixture(); const previous = process.env.BAUBLE_TEST_MODE; process.env.BAUBLE_TEST_MODE = '1';
  t.after(() => { if (previous === undefined) delete process.env.BAUBLE_TEST_MODE; else process.env.BAUBLE_TEST_MODE = previous; rmSync(f.root, { recursive: true, force: true }); });
  const job = await captureTask({ cwd: f.cwd, prompt: 'do not replay' }, f.source, f.target); const id = job.manifest.transferId; f.source.approve(id, job.digest);
  let calls = 0; let launches = 0;
  const rpc: Rpc = async request => { calls++; return handleRequest(request, { config: f.config, allowFixture: true, launch: async () => { launches++; } }); };
  writeFileSync(join(f.cwd, 'keep.txt'), 'changed'); await assert.rejects(dispatchTask(f.source, id, rpc, f.remoteRoot), /Source workspace changed/); assert.equal(calls, 0);
  writeFileSync(join(f.cwd, 'keep.txt'), 'original');
  let release!: () => void; let entered!: () => void; const waiting = new Promise<void>(ok => { entered = ok; }); const gate = new Promise<void>(ok => { release = ok; });
  const lost: Rpc = async request => { if (request.operation === 'manifest') { entered(); await gate; } if (request.operation === 'activate') throw new Error('crashed before activation send'); return rpc(request); };
  const dispatch = dispatchTask(f.source, id, lost, f.remoteRoot); await waiting;
  await assert.rejects(recover(id, true, f.source, { config: f.config, connect: () => rpc }), /Locked/); release();
  await assert.rejects(dispatch, { code: 'AUTHORITY_UNCERTAIN' });
  const operations: string[] = []; const status = await dispatchTask(f.source, id, async request => { operations.push(request.operation); return rpc(request); }, f.remoteRoot);
  assert.deepEqual(operations, ['status']); assert.equal(status.phase, 'unknown'); assert.equal(launches, 0); assert.equal(f.remote.status(id).phase, 'ready');
});

test('run: nested Git cwd mapping retains repository root and rejects invalid Git rather than falling back to folder', async t => {
  const f = fixture(true); const previous = process.env.BAUBLE_TEST_MODE; process.env.BAUBLE_TEST_MODE = '1';
  t.after(() => { if (previous === undefined) delete process.env.BAUBLE_TEST_MODE; else process.env.BAUBLE_TEST_MODE = previous; rmSync(f.root, { recursive: true, force: true }); });
  const nested = join(f.cwd, 'nested'); mkdirSync(nested); writeFileSync(join(nested, 'file'), 'nested');
  const job = await captureTask({ cwd: nested, prompt: 'literal' }, f.source, f.target);
  assert.equal(job.manifest.source.repository, f.cwd); assert.equal(job.manifest.target.cwd, join(job.manifest.target.repository, 'nested'));
  writeFileSync(join(f.cwd, '.git', 'MERGE_HEAD'), 'unsupported'); await assert.rejects(captureTask({ cwd: nested, prompt: 'literal' }, f.source, f.target), /Unresolved Git operation/);
});

test('host CLI: ordinary nonsecret Pi selection bootstraps only controlled builtins, never ambient resources', { timeout: 30000 }, async t => {
  const { InMemoryCredentialStore, getSupportedThinkingLevels } = await import('@earendil-works/pi-ai'); const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), allowModelNetwork: false, modelsPath: join(f.root, 'absent-models.json'), modelsStorePath: join(f.root, 'models-store.json') });
  const model = runtime.getModels().find(model => getSupportedThinkingLevels(model).includes('off'))!;
  const home = join(f.root, 'home'); const bin = join(f.root, 'bin'); mkdirSync(home); mkdirSync(bin);
  const settings = join(home, '.pi/agent/settings.json'); const marker = 'PRIVATE_AMBIENT_SETTING_MUST_NOT_COPY';
  atomicWrite(settings, json({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: 'off', packages: [marker], extensions: [marker], shellCommandPrefix: marker, credentials: marker }));
  const seeded = { version: 1 as const, policy: 'bauble-pi-v1' as const, provider: model.provider, model: model.id, thinking: 'off' as const, tools: ['read', 'bash', 'edit', 'write'] as ('read' | 'bash' | 'edit' | 'write')[], instructions: [], skills: [], prompts: [], executables: [], services: [], settings: { compaction: { enabled: true } }, testOnly: false };
  const digest = snapshotProfile(seeded, f.root, f.source.blobs).digest; const helper = resolve('dist/test/run-helper.js'); const remoteConfig = join(f.root, 'remote-config.json'); atomicWrite(remoteConfig, json(f.config));
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nexec '${process.execPath}' '${helper}'\n`, { mode: 0o700 }); const config = join(f.root, 'new-config', 'config.json');
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BAUBLE_CONFIG: config, BAUBLE_STATE: f.source.root, BAUBLE_TEST_REMOTE_CONFIG: remoteConfig, BAUBLE_TEST_REMOTE_ROOT: f.remoteRoot, BAUBLE_TEST_PROFILE_DIGEST: digest };
  const result = spawnSync(process.execPath, ['dist/src/cli.js', 'host', 'add', 'remote', '--default'], { env, encoding: 'utf8', timeout: 20000 }); assert.equal(result.status, 0, result.stderr);
  const configured = JSON.parse(readFileSync(config, 'utf8')); const actual = JSON.parse(readFileSync(configured.profile, 'utf8')); assert.deepEqual(actual, seeded); assert.ok(!result.stdout.includes(marker)); assert.equal(existsSync(join(f.source.root, 'sessions')), false); assert.equal(readFileSync(settings, 'utf8').includes(marker), true);
});
