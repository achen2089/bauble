import { readLog } from '../src/log.js';
import { streamRpc } from '../src/stream.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createConnection } from 'node:net';
import { fixtureRoot, fixtureProfile, fixtureRepo, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { createManaged } from '../src/pi/runtime.js';
import { captureCheckpoint } from '../src/checkpoint.js';
import { handleRequest, prepareRestore, sendCheckpoint } from '../src/protocol.js';
import { captureLive, internalRuntime } from '../src/commands.js';
import { acceptMessage, checkMessageRuntime, MAX_TEXT, MessageResult, MessageText, messageSession, messageStatus } from '../src/message.js';
import { control, controlServer, readMessage, type Rpc } from '../src/transport.js';
import type { Config } from '../src/schema.js';
import { atomicWrite, hash, json, removeFile } from '../src/safe.js';
import { fixtureContexts } from '../src/pi/fixture.js';
import { Readable } from 'node:stream';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

async function pair(t: TestContext) {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const profile = fixtureProfile(root); const native = fixtureSession(repo, root); const source = new Store(join(root, 'source'));
  const skill = join(root, 'message-test'); const prompt = join(root, 'message-template.md');
  atomicWrite(join(skill, 'SKILL.md'), '---\nname: message-test\ndescription: Deterministic fixture skill\n---\nEXPANDED SKILL MUST NOT APPEAR\n');
  atomicWrite(prompt, '---\ndescription: Deterministic fixture template\n---\nEXPANDED TEMPLATE MUST NOT APPEAR\n');
  profile.profile.skills = [skill]; profile.profile.prompts = [prompt]; atomicWrite(profile.path, json(profile.profile));
  const original = await createManaged({ store: source, profilePath: profile.path, cwd: repo, manager: native.manager, allowTest: true });
  const reg = await original.settled(); const configured = join(root, 'destination'); const remoteRoot = join(configured, 'fixtures', randomUUID());
  const config: Config = { version: 1, hosts: { destination: { root: remoteRoot, profileDigest: reg.profileDigest } }, profile: profile.path, localRoot: source.root, remoteRoot: configured };
  const checkpoint = captureCheckpoint({ store: source, registration: reg, profile: profile.profile, destination: 'destination', targetRoot: remoteRoot, live: original.runtime.session });
  const id = checkpoint.manifest.transferId; source.approve(id, checkpoint.digest); let launches = 0; let managed!: Awaited<ReturnType<typeof internalRuntime>>;
  const rpc: Rpc = request => handleRequest(request, { config, allowFixture: true, launch: async (store, id) => { launches++; prepareRestore(store, id); managed = await internalRuntime(id, store.root, false); } });
  await sendCheckpoint(source, id, rpc, remoteRoot);
  const remote = new Store(remoteRoot); const receipt = remote.status(id).receipt!;
  t.after(async () => { await managed.close(); await original.close(); rmSync(root, { recursive: true, force: true }); });
  const options = { config, connect: (alias: string) => { assert.equal(alias, 'destination'); return rpc; } };
  return { root, repo, source, remote, config, id, managed, receipt, options, rpc, launches: () => launches };
}
function submission(receipt: Awaited<ReturnType<typeof pair>>['receipt'], text: string, requestId = randomUUID()) { return { requestId, receipt, text, textDigest: hash(text) }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok; }); return { promise, resolve }; }
async function settled(f: Awaited<ReturnType<typeof pair>>) { await Promise.all([...f.managed.guard.pending]); await f.managed.runtime.session.waitForIdle(); await new Promise(ok => setImmediate(ok)); }
function userTexts(f: Awaited<ReturnType<typeof pair>>) { return f.managed.runtime.session.sessionManager.getEntries().flatMap(e => e.type === 'message' && e.message.role === 'user' ? [typeof e.message.content === 'string' ? e.message.content : e.message.content.filter(c => c.type === 'text').map(c => c.text).join('')] : []); }

test('message: store-global UUID binding excludes competing transfers in separate native processes', { timeout: 60000 }, async t => {
  const root = fixtureRoot(); const remoteRoot = join(root, 'fixtures', randomUUID()); const release = join(root, 'release');
  const children: ChildProcess[] = [];
  const next = (child: ChildProcess) => new Promise<any>((ok, fail) => {
    const timer = setTimeout(() => { child.off('message', received); fail(new Error('Child response timeout')); }, 25000);
    const received = (value: unknown) => { clearTimeout(timer); ok(value); }; child.once('message', received);
  });
  t.after(async () => {
    writeFileSync(release, 'release');
    try {
      await Promise.all(children.map(child => new Promise<void>((ok, fail) => {
        if (child.exitCode !== null || child.signalCode !== null) return ok();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
        child.once('exit', () => { clearTimeout(timeout); timedOut ? fail(new Error('Exact fixture child required forced cleanup')) : ok(); });
        if (child.connected) child.send({ operation: 'close' });
      })));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (let i = 0; i < 2; i++) {
    const child = fork('dist/test/message-process.js', [remoteRoot], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }); children.push(child);
    assert.equal((await next(child)).type, 'ready');
  }
  const [a, b] = children as [ChildProcess, ChildProcess]; const requestId = randomUUID();
  let response = next(a); a.send({ operation: 'submit', requestId, hold: release }); assert.equal((await response).type, 'blocked');
  response = next(b); b.send({ operation: 'submit', requestId }); assert.match((await response).error, /Locked:/);
  response = next(a); writeFileSync(release, 'release'); const accepted = await response;
  assert.equal(accepted.state, 'accepted'); assert.equal(accepted.count, 1);
  const ledger = readFileSync(join(remoteRoot, 'message-inbox', requestId + '.json'));
  response = next(b); b.send({ operation: 'submit', requestId }); assert.match((await response).error, /receipt changed/i);
  assert.deepEqual(readFileSync(join(remoteRoot, 'message-inbox', requestId + '.json')), ledger);
  response = next(a); a.send({ operation: 'submit', requestId }); const duplicate = await response;
  assert.equal(duplicate.state, 'accepted'); assert.equal(duplicate.count, 1);
});

test('message: first-use ledgers sync their parent before intent and dispatch; failed barriers prevent submission, including retries', async t => {
  const f = await pair(t); const events: string[] = []; const descriptors = new Map<number, string>();
  const open = fs.openSync; const sync = fs.fsyncSync; let failRoot: string | undefined;
  t.mock.method(fs, 'openSync', ((path, ...args) => { const fd = open(path, ...args); descriptors.set(fd, String(path)); events.push('open:' + String(path)); return fd; }) as typeof fs.openSync);
  t.mock.method(fs, 'fsyncSync', (fd: number) => { const path = descriptors.get(fd)!; events.push('sync:' + path); if (path === failRoot) throw new Error('injected ledger parent barrier'); sync(fd); });
  syncBuiltinESMExports();
  try {
    let sends = 0;
    const options = { ...f.options, connect: () => async (request: Parameters<Rpc>[0]) => {
      if (request.operation === 'message') { events.push('dispatch'); sends++; }
      return f.rpc(request);
    } };
    const clientId = randomUUID(); failRoot = f.source.root;
    for (let i = 0; i < 2; i++) {
      await assert.rejects(messageSession(f.id, 'first client intent', clientId, f.source, options), /ledger parent barrier/);
      assert.ok(existsSync(join(f.source.root, 'message-outbox')));
      assert.ok(!existsSync(join(f.source.root, 'message-outbox', clientId + '.json'))); assert.equal(sends, 0);
    }
    const item = submission(f.receipt, 'first native intent'); failRoot = f.remote.root; const before = fixtureContexts.length;
    for (let i = 0; i < 2; i++) {
      await assert.rejects(acceptMessage(f.managed, f.remote, item), /ledger parent barrier/);
      assert.ok(existsSync(join(f.remote.root, 'message-inbox')));
      assert.ok(!existsSync(join(f.remote.root, 'message-inbox', item.requestId + '.json')));
      assert.equal(f.managed.guard.messageReserved, false); assert.equal(fixtureContexts.length, before);
    }
    // Exercise actual fresh directory creation again, now with successful durability barriers.
    rmSync(join(f.source.root, 'message-outbox'), { recursive: true }); rmSync(join(f.remote.root, 'message-inbox'), { recursive: true });
    failRoot = undefined; events.length = 0;
    const emit = f.managed.runtime.session.extensionRunner.emitInput.bind(f.managed.runtime.session.extensionRunner);
    f.managed.runtime.session.extensionRunner.emitInput = async (...args) => { events.push('native-preflight'); return emit(...args); };
    assert.equal((await messageSession(f.id, 'first client intent', clientId, f.source, options)).state, 'accepted'); await settled(f);
    for (const [store, ledger, boundary] of [[f.source, 'message-outbox', 'dispatch'], [f.remote, 'message-inbox', 'native-preflight']] as const) {
      const parent = events.indexOf('sync:' + store.root);
      const intent = events.findIndex(event => event.startsWith('open:' + join(store.root, ledger, clientId + '.json.')));
      const directory = events.indexOf('sync:' + join(store.root, ledger));
      assert.ok(parent >= 0 && parent < intent && intent < directory && directory < events.indexOf(boundary), events.join('\n'));
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('message: actual native acceptance, local and SSH-helper routing, literal text, metadata-only logs and no launch', async t => {
  const f = await pair(t); const session = f.managed.runtime.session;
  const beforeOwner = f.remote.owner(f.receipt.lineageId); const beforeSource = f.source.owner(f.receipt.lineageId);
  for (const text of ['/bauble destination', '/skill:message-test $ARGUMENTS', '/message-template "$(touch hostile)";\n!echo nope', 'fixture:write {"path":"message-result.txt","content":"native message"}']) {
    const requestId = randomUUID();
    const value = await messageSession(f.id, text, requestId, f.source, f.options);
    assert.equal(value.state, 'accepted'); assert.equal(value.task, 'not-tracked'); assert.equal(value.textDigest, hash(text));
    await settled(f);
    assert.equal(userTexts(f).filter(t => t === text).length, 1);
    assert.deepEqual(await messageSession(f.id, text, requestId, f.source, f.options), value);
    assert.deepEqual(await messageStatus(f.id, requestId, f.source, f.options), value);
    assert.deepEqual(await messageStatus(f.id, requestId, f.remote, { config: f.config }), value);
    await assert.rejects(messageSession(f.id, text + 'changed', requestId, f.source, f.options), /different transfer\/text/);
    const metadata = readFileSync(join(f.source.root, 'message-outbox', requestId + '.json'), 'utf8') + readFileSync(join(f.remote.root, 'message-inbox', requestId + '.json'), 'utf8');
    assert.ok(!metadata.includes(text));
  }
  const localConfig = { ...f.config, hosts: {} };
  assert.equal((await messageSession(f.id, 'local control only', randomUUID(), f.remote, { config: localConfig, connect: () => { throw new Error('SSH forbidden'); } })).state, 'accepted');
  await settled(f);
  assert.equal(readFileSync(join(session.sessionManager.getCwd(), 'message-result.txt'), 'utf8'), 'native message');
  assert.ok(!readFileSync(join(f.remote.transfer(f.id), 'run.log'), 'utf8').includes('native message'));
  assert.deepEqual(f.remote.owner(f.receipt.lineageId), beforeOwner); assert.deepEqual(f.source.owner(f.receipt.lineageId), beforeSource); assert.equal(f.launches(), 1);
  assert.deepEqual(f.remote.status(f.id).receipt, f.receipt);
  assert.ok(!existsSync(join(f.repo, 'message-result.txt')));
});

test('message: lost ACK reconciles without resend, duplicate and concurrent senders deliver only once', async t => {
  const f = await pair(t); let deliveries = 0; const requestId = randomUUID(); const text = 'once despite lost ACK';
  const lossy: Rpc = async request => { const value = await f.rpc(request); if (request.operation === 'message') { deliveries++; throw new Error('lost ACK'); } return value; };
  const options = { config: f.config, connect: () => lossy };
  assert.equal((await messageSession(f.id, text, requestId, f.source, options)).state, 'uncertain');
  await settled(f);
  assert.equal((await messageSession(f.id, text, requestId, f.source, options)).state, 'accepted');
  assert.equal(deliveries, 1); assert.equal(userTexts(f).filter(t => t === text).length, 1);
  const next = submission(f.receipt, 'concurrent native duplicates');
  const values = await Promise.all([1, 2, 3].map(() => control(f.managed.registration.socket, { operation: 'message', ...next })));
  assert.ok(values.every(value => ['accepted', 'uncertain'].includes(MessageResult.parse(value).state)));
  await settled(f); assert.equal(userTexts(f).filter(t => t === next.text).length, 1);
  await assert.rejects(control(f.managed.registration.socket, { operation: 'message', ...next, text: 'changed', textDigest: hash('changed') }), /different text digest/);
  const concurrentId = randomUUID();
  const clients = await Promise.all([1, 2, 3].map(() => messageSession(f.id, 'same client ID', concurrentId, f.source, f.options)));
  assert.ok(clients.every(v => ['accepted', 'uncertain'].includes(v.state))); await settled(f);
  assert.equal(userTexts(f).filter(t => t === 'same client ID').length, 1);
});

test('message: delayed native preflight reserves admission; busy requests reject without queue, abort, terminal mutation or capture', async t => {
  const f = await pair(t); const session = f.managed.runtime.session; const entered = deferred(); const release = deferred();
  const emit = session.extensionRunner.emitInput.bind(session.extensionRunner);
  session.extensionRunner.emitInput = async (...args) => { entered.resolve(); await release.promise; return emit(...args); };
  const first = submission(f.receipt, 'delayed literal acceptance'); const sending = acceptMessage(f.managed, f.remote, first); await entered.promise;
  assert.equal(session.isStreaming, false, 'Native preflight has not set streaming yet');
  assert.equal((await messageStatus(f.id, first.requestId, f.remote, { config: f.config })).state, 'uncertain');
  assert.throws(() => session.prompt('terminal race'), /busy/);
  assert.throws(() => session.setThinkingLevel('high'), /busy/);
  assert.throws(() => session.navigateTree(f.receipt.leaf), /busy/);
  assert.throws(() => session.executeBash('touch race'), /busy/);
  await assert.rejects(captureLive(f.managed, f.remote, { destination: 'local', targetRoot: join(f.root, 'return') }), /busy/);
  const second = submission(f.receipt, 'must reject busy');
  assert.equal((await acceptMessage(f.managed, f.remote, second)).reason, 'busy');
  release.resolve(); assert.equal((await sending).state, 'accepted'); await settled(f);
  assert.equal((await acceptMessage(f.managed, f.remote, second)).state, 'rejected', 'Same rejected ID is terminal');
  assert.ok(!userTexts(f).includes(second.text)); assert.equal(session.pendingMessageCount, 0);
  assert.equal((await acceptMessage(f.managed, f.remote, submission(f.receipt, second.text))).state, 'accepted'); await settled(f);
  assert.equal(userTexts(f).filter(t => t === first.text).length, 1); assert.equal(userTexts(f).filter(t => t === second.text).length, 1);
});

test('message: acceptance ACK precedes model/task completion and rejects active native work', async t => {
  const f = await pair(t); const session = f.managed.runtime.session;
  const gate = deferred(); const started = deferred(); const provider = session.modelRuntime.getProvider('bauble-fixture')!;
  const stream = provider.streamSimple.bind(provider);
  // Actual native runtime and fixture provider, delayed at provider invocation; no paid inference.
  provider.streamSimple = (...args) => {
    const output = createAssistantMessageEventStream(); started.resolve();
    void (async () => { await gate.promise; for await (const event of stream(...args)) output.push(event); output.end(); })();
    return output;
  };
  const text = 'accepted not completed';
  try {
    const value = await acceptMessage(f.managed, f.remote, submission(f.receipt, text));
    assert.equal(value.state, 'accepted'); assert.equal(value.task, 'not-tracked'); await started.promise;
    assert.equal(session.isIdle, false); assert.equal(f.managed.guard.messageReserved, true);
    assert.equal((await acceptMessage(f.managed, f.remote, submission(f.receipt, 'busy native'))).reason, 'busy');
  } finally { gate.resolve(); await settled(f); provider.streamSimple = stream; }
});

test('message: ambiguous client intent with missing destination receipt never replays, including delayed delivery', async t => {
  const f = await pair(t); const requestId = randomUUID(); const text = 'late network arrival'; let delayed: Parameters<Rpc>[0] | undefined; let sends = 0;
  const lost: Rpc = async request => { if (request.operation === 'message') { delayed = request; sends++; throw new Error('lost before delivery'); } return f.rpc(request); };
  const options = { config: f.config, connect: () => lost };
  const value = await messageSession(f.id, text, requestId, f.source, options); assert.equal(value.state, 'uncertain');
  const outbox = readFileSync(join(f.source.root, 'message-outbox', requestId + '.json'));
  assert.equal((await messageStatus(f.id, requestId, f.source, options)).state, 'uncertain');
  assert.equal((await messageSession(f.id, text, requestId, f.source, options)).state, 'uncertain'); assert.equal(sends, 1);
  assert.equal(userTexts(f).filter(t => t === text).length, 0);
  assert.equal(MessageResult.parse(await f.rpc(delayed!)).state, 'accepted'); await settled(f);
  assert.equal((await messageStatus(f.id, requestId, f.source, options)).state, 'accepted');
  assert.deepEqual(readFileSync(join(f.source.root, 'message-outbox', requestId + '.json')), outbox, 'Reconciliation is read-only');
  const intent = submission(f.receipt, 'crashed native intent');
  const path = join(f.remote.root, 'message-inbox', intent.requestId + '.json');
  atomicWrite(path, json({ requestId: intent.requestId, receipt: intent.receipt, textDigest: intent.textDigest, state: 'intent' }));
  assert.equal((await acceptMessage(f.managed, f.remote, intent)).state, 'uncertain'); assert.ok(!userTexts(f).includes(intent.text));
});

test('message: frozen/stale owner, missing receipt/registration and old capability fail closed without launch', async t => {
  const f = await pair(t); const text = 'never delivered'; const originalOwner = f.remote.owner(f.receipt.lineageId);
  for (const owner of [{ ...originalOwner, state: 'frozen' as const }, { ...originalOwner, state: 'fenced' as const }, { ...originalOwner, generation: originalOwner.generation + 1 }, { ...originalOwner, transferId: randomUUID() }, { ...originalOwner, digest: hash('stale') }]) {
    f.remote.setOwner(owner); await assert.rejects(messageSession(f.id, text, randomUUID(), f.source, f.options));
  }
  f.remote.setOwner(originalOwner);
  f.managed.guard.phase = 'frozen'; await assert.rejects(checkMessageRuntime(f.remote, f.receipt), /frozen/); f.managed.guard.phase = 'open';
  const status = f.remote.status(f.id); const { receipt: _receipt, ...missing } = status; atomicWrite(join(f.remote.transfer(f.id), 'status.json'), json(missing));
  await assert.rejects(checkMessageRuntime(f.remote, f.receipt), /Missing readiness receipt/); atomicWrite(join(f.remote.transfer(f.id), 'status.json'), json(status));
  const regPath = join(f.remote.root, 'sessions', hash(f.receipt.sessionFile) + '.json'); const regBytes = readFileSync(regPath); rmSync(regPath);
  await assert.rejects(checkMessageRuntime(f.remote, f.receipt), /registration/); writeFileSync(regPath, regBytes);
  const fakeSocket = join(f.root, 'old.sock'); const oldServer = await controlServer(fakeSocket, async () => ({ registration: f.managed.registration, frozen: 'open', idle: true }));
  const reg = f.remote.registration(f.receipt.sessionId); f.remote.register({ ...reg, socket: fakeSocket });
  try { await assert.rejects(checkMessageRuntime(f.remote, f.receipt), /lacks message-v1/); }
  finally { oldServer.close(); removeFile(fakeSocket); f.remote.register(reg); }
  for (const receipt of [{ ...f.receipt, nonce: randomUUID() }, { ...f.receipt, sessionId: 'wrong' }, { ...f.receipt, start: 'stale' }]) await assert.rejects(acceptMessage(f.managed, f.remote, submission(receipt, text)), /receipt changed/i);
  assert.ok(!userTexts(f).includes(text)); assert.equal(f.launches(), 1);
});

test('message: native callback revalidation prevents prompt inference; expired reservations cannot mutate', async t => {
  const f = await pair(t); const session = f.managed.runtime.session; const entered = deferred(); const release = deferred(); const emit = session.extensionRunner.emitInput.bind(session.extensionRunner);
  session.extensionRunner.emitInput = async (...args) => { const value = await emit(...args); entered.resolve(); await release.promise; return value; };
  const text = 'must not reach provider'; const before = fixtureContexts.length; const item = submission(f.receipt, text);
  const sending = acceptMessage(f.managed, f.remote, item); await entered.promise;
  const owner = f.remote.owner(f.receipt.lineageId); f.remote.setOwner({ ...owner, state: 'fenced' }); release.resolve();
  assert.equal((await sending).state, 'uncertain'); await settled(f); f.remote.setOwner(owner);
  assert.equal(fixtureContexts.length, before); assert.ok(!userTexts(f).includes(text));
  assert.equal((await acceptMessage(f.managed, f.remote, item)).state, 'uncertain');
  session.extensionRunner.emitInput = emit;
  const reservation = f.managed.guard.reserveMessage(session); let late!: () => void;
  reservation.run(() => { late = () => session.setSessionName('stale callback'); setImmediate(() => assert.throws(late, /Expired message reservation/)); });
  reservation.release(); await new Promise(ok => setImmediate(ok));
  const delayed = deferred(); const object = { async mutation() { await delayed.promise; } }; f.managed.guard.wrap(object, ['mutation']);
  const next = f.managed.guard.reserveMessage(session); const mutation = next.run(() => object.mutation()); next.release(); delayed.resolve();
  await assert.rejects(mutation, /Expired message reservation/); assert.equal(f.managed.guard.phase, 'frozen');
});

test('message: bounded malicious input and fragmented control framing never become shell commands or leak parse text', async t => {
  assert.throws(() => MessageText.parse('')); assert.throws(() => MessageText.parse('x'.repeat(MAX_TEXT + 1))); assert.throws(() => MessageText.parse('🦊'.repeat(MAX_TEXT / 2))); assert.throws(() => MessageText.parse('a\0b')); assert.throws(() => MessageText.parse('\ud800'));
  await assert.rejects(readMessage(Readable.from(['x'.repeat(2 * 1024 * 1024 + 1)])), /size limit/);
  await assert.rejects(readMessage(Readable.from(['secret-malformed'])), error => !String(error).includes('secret-malformed'));
  await assert.rejects(readMessage(Readable.from([Buffer.from([0xff])])), /UTF-8/);
  const f = await pair(t); const item = submission(f.receipt, 'literal boundary\n'.repeat(2000));
  const payload = JSON.stringify({ operation: 'message', ...item }) + '\n';
  const response = await new Promise<string>((ok, fail) => {
    const socket = createConnection(f.managed.registration.socket); let response = '';
    socket.on('error', fail); socket.on('data', chunk => { response += chunk; }); socket.on('end', () => ok(response));
    socket.on('connect', () => { socket.write(payload.slice(0, 100)); setImmediate(() => socket.end(payload.slice(100))); });
  });
  assert.equal(JSON.parse(response).data.state, 'accepted'); await settled(f);
  assert.equal(userTexts(f).filter(t => t === item.text).length, 1);
  await assert.rejects(acceptMessage(f.managed, f.remote, { ...item, requestId: '../escape' }));
  await assert.rejects(acceptMessage(f.managed, f.remote, { ...item, requestId: randomUUID(), textDigest: hash('wrong') }), /digest mismatch/);
  const raw = (payload: string) => new Promise<string>((ok, fail) => {
    const socket = createConnection(f.managed.registration.socket); let output = '';
    socket.on('error', fail); socket.on('data', chunk => { output += chunk; }); socket.on('end', () => ok(output));
    socket.on('connect', () => { socket.write(payload.slice(0, 3)); setImmediate(() => socket.end(payload.slice(3))); });
  });
  assert.equal(JSON.parse(await raw(json({ operation: 'observe' }))).ok, true, 'Legacy pretty JSON is still supported across chunks');
  assert.ok(!(await raw('{secret-malformed}\n')).includes('secret-malformed'));
  await assert.rejects(control(f.managed.registration.socket, { operation: 'message', text: 'x'.repeat(2 * 1024 * 1024) }), /2 MiB limit/);
});

test('message CLI: explicit request-ID status, literal argv and local state routing', async t => {
  const f = await pair(t); const configPath = join(f.root, 'cli-config.json'); atomicWrite(configPath, json({ ...f.config, localRoot: f.remote.root, remoteRoot: f.remote.root, hosts: {} }));
  const cli = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((ok, fail) => {
    const child = spawn(process.execPath, ['dist/src/cli.js', ...args], { env: { ...process.env, BAUBLE_STATE: f.remote.root, BAUBLE_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.on('error', fail); child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('exit', code => ok({ code, stdout, stderr }));
  });
  const requestId = randomUUID(); const text = '-literal $(touch NEVER)\n/bauble';
  const sent = await cli(['message', f.id, '--json', '--request-id', requestId, '--', text]); assert.equal(sent.code, 0, sent.stderr); assert.equal(JSON.parse(sent.stdout).data.state, 'accepted'); assert.ok(!sent.stderr.includes(text)); assert.ok(sent.stderr.includes(requestId));
  await settled(f); const status = await cli(['message-status', f.id, '--json', '--request-id', requestId]); assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).data.requestId, requestId);
  assert.equal((await cli(['message-status', f.id])).code, 2); assert.equal((await cli(['message', f.id, 'a', 'b'])).code, 2);
  assert.equal(userTexts(f).filter(t => t === text).length, 1);
});

test('message: auth and automatic compaction preflight cannot race a terminal prompt or ownership capture', { timeout: 60000 }, async t => {
  const f = await pair(t); const session = f.managed.runtime.session; const models = session.modelRuntime;
  const configured = models.hasConfiguredAuth.bind(models); const check = models.checkAuth.bind(models);
  const entered = deferred(); const release = deferred();
  models.hasConfiguredAuth = () => false;
  models.checkAuth = async (...args) => { entered.resolve(); await release.promise; return check(...args); };
  const pending = acceptMessage(f.managed, f.remote, submission(f.receipt, 'auth preflight'));
  await entered.promise;
  try {
    assert.equal(session.isStreaming, false);
    assert.throws(() => session.prompt('auth race'), /busy/);
    await assert.rejects(f.managed.settled(), /busy/);
    assert.equal((await acceptMessage(f.managed, f.remote, submission(f.receipt, 'busy auth'))).reason, 'busy');
  } finally { release.resolve(); models.hasConfiguredAuth = configured; models.checkAuth = check; }
  assert.equal((await pending).state, 'accepted'); await settled(f);
  const compactEntered = deferred(); const compactRelease = deferred();
  session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 127999, keepRecentTokens: 1 } });
  const emit = session.extensionRunner.emit.bind(session.extensionRunner); let compactions = 0;
  session.extensionRunner.emit = async event => {
    if (event.type === 'session_before_compact') { compactions++; compactEntered.resolve(); await compactRelease.promise; session.settingsManager.setCompactionEnabled(false); }
    return emit(event);
  };
  const compacting = acceptMessage(f.managed, f.remote, submission(f.receipt, 'compaction preflight'));
  await compactEntered.promise;
  try {
    assert.equal(session.isCompacting, true); assert.equal(session.isStreaming, false);
    assert.throws(() => session.prompt('compaction race'), /busy/);
    await assert.rejects(f.managed.settled(), /busy/);
    assert.equal((await acceptMessage(f.managed, f.remote, submission(f.receipt, 'busy compaction'))).reason, 'busy');
  } finally { compactRelease.resolve(); }
  assert.equal((await compacting).state, 'accepted'); await settled(f);
  assert.equal(compactions, 1); assert.equal(session.pendingMessageCount, 0);
});

test('message: native preflight rejection is durable, receipt write failure is uncertain with no prompt inference', async t => {
  const f = await pair(t); const session = f.managed.runtime.session;
  const configured = session.modelRuntime.hasConfiguredAuth.bind(session.modelRuntime); const check = session.modelRuntime.checkAuth.bind(session.modelRuntime);
  session.modelRuntime.hasConfiguredAuth = () => false; session.modelRuntime.checkAuth = async () => undefined;
  const rejected = submission(f.receipt, 'no configured auth');
  assert.equal((await acceptMessage(f.managed, f.remote, rejected)).state, 'rejected'); await settled(f);
  session.modelRuntime.hasConfiguredAuth = configured; session.modelRuntime.checkAuth = check;
  assert.equal((await acceptMessage(f.managed, f.remote, rejected)).reason, 'preflight'); assert.ok(!userTexts(f).includes(rejected.text));
  const entered = deferred(); const release = deferred(); const emit = session.extensionRunner.emitInput.bind(session.extensionRunner);
  session.extensionRunner.emitInput = async (...args) => { const result = await emit(...args); entered.resolve(); await release.promise; return result; };
  const item = submission(f.receipt, 'receipt failure must not reach provider'); const before = fixtureContexts.length;
  const sending = acceptMessage(f.managed, f.remote, item); await entered.promise;
  const path = join(f.remote.root, 'message-inbox', item.requestId + '.json'); const bytes = readFileSync(path);
  rmSync(path); mkdirSync(path); release.resolve();
  assert.equal((await sending).state, 'uncertain'); await settled(f);
  assert.equal(fixtureContexts.length, before); assert.ok(!userTexts(f).includes(item.text));
  rmSync(path, { recursive: true }); atomicWrite(path, bytes);
  assert.equal((await acceptMessage(f.managed, f.remote, item)).state, 'uncertain');
});

test('message: actual lost socket ACK and client crash before dispatch reconcile read-only, even after shutdown', async t => {
  const f = await pair(t); const session = f.managed.runtime.session; const entered = deferred(); const release = deferred(); const emit = session.extensionRunner.emitInput.bind(session.extensionRunner);
  session.extensionRunner.emitInput = async (...args) => { entered.resolve(); await release.promise; return emit(...args); };
  const item = submission(f.receipt, 'disconnected caller');
  const socket = createConnection(f.managed.registration.socket); socket.on('error', () => {});
  await new Promise<void>(ok => socket.on('connect', () => { socket.write(JSON.stringify({ operation: 'message', ...item }) + '\n'); ok(); }));
  await entered.promise; socket.destroy(); release.resolve(); await settled(f);
  assert.equal((await messageStatus(f.id, item.requestId, f.remote, { config: f.config })).state, 'accepted');
  assert.equal((await acceptMessage(f.managed, f.remote, item)).state, 'accepted'); assert.equal(userTexts(f).filter(t => t === item.text).length, 1);
  const crashId = randomUUID(); let sends = 0;
  const options = { ...f.options, connect: () => async (request: Parameters<Rpc>[0]) => { if (request.operation === 'message') sends++; return f.rpc(request); }, onIntent: () => { throw new Error('injected client crash'); } };
  await assert.rejects(messageSession(f.id, 'never dispatched', crashId, f.source, options), /client crash/);
  assert.equal((await messageSession(f.id, 'never dispatched', crashId, f.source, options)).state, 'uncertain'); assert.equal(sends, 0);
  const bytes = readFileSync(join(f.remote.root, 'message-inbox', item.requestId + '.json'));
  await f.managed.close();
  assert.equal((await messageStatus(f.id, item.requestId, f.remote, { config: f.config })).state, 'accepted');
  assert.deepEqual(readFileSync(join(f.remote.root, 'message-inbox', item.requestId + '.json')), bytes);
});


test('message stream: one helper for preflight/delivery; lost channel cannot cancel admitted native preflight', async t => {
  const f = await pair(t); const configPath = join(f.root, 'stream-config.json'); writeFileSync(configPath, JSON.stringify(f.config));
  const entered = deferred(); const release = deferred(); const emit = f.managed.runtime.session.extensionRunner.emitInput.bind(f.managed.runtime.session.extensionRunner);
  f.managed.runtime.session.extensionRunner.emitInput = async (...args) => { entered.resolve(); await release.promise; return emit(...args); };
  let helpers = 0; const rpc = streamRpc(() => { helpers++; return spawn(process.execPath, [resolve('dist/src/cli.js'), '_helper-stream'], { env: { ...process.env, BAUBLE_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] }); });
  const requestId = randomUUID(); let intent = '';
  try {
    const sending = messageSession(f.id, 'stream disconnected literal', requestId, f.source, { config: f.config, connect: () => rpc, onIntent: id => { intent = id; } });
    await entered.promise; assert.equal(intent, requestId); rpc.close();
    assert.equal((await sending).state, 'uncertain'); release.resolve(); await settled(f);
    assert.equal((await messageStatus(f.id, requestId, f.remote, { config: f.config })).state, 'accepted');
    assert.equal(userTexts(f).filter(text => text === 'stream disconnected literal').length, 1); assert.equal(helpers, 1); assert.equal(f.launches(), 1);
  } finally { release.resolve(); rpc.close(); }
});


test('hostRuntime log producer: appends preserve cursor identity, emit only new bytes and retain message redaction', async t => {
  const f = await pair(t); const path = join(f.remote.transfer(f.id), 'run.log');
  await messageSession(f.id, 'first secret message marker', randomUUID(), f.source, f.options); await settled(f);
  const first = readLog(path); const prefix = readFileSync(path); assert.ok(first.text.includes('contentOmitted')); assert.ok(!first.text.includes('first secret message marker'));
  await messageSession(f.id, 'second secret message marker', randomUUID(), f.source, f.options); await settled(f);
  const next = readLog(path, first.cursor!); const all = readFileSync(path);
  assert.equal(next.cursor!.identity, first.cursor!.identity); assert.equal(next.reset, false); assert.ok(next.text.length > 0);
  assert.deepEqual(all.subarray(0, prefix.length), prefix); assert.equal(next.text, all.subarray(prefix.length).toString('utf8')); assert.ok(next.text.includes('contentOmitted'));
  assert.ok(!all.toString().includes('first secret message marker')); assert.ok(!all.toString().includes('second secret message marker')); assert.equal(readLog(path, next.cursor!).text, '');
});
