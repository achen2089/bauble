import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { Manifest, type Config, type Receipt, type Registration } from '../src/schema.js';
import { fixtureProfile, fixtureRoot } from './fixtures.js';
import { atomicWrite, json, run } from '../src/safe.js';
import { attachmentBinding, AttachTicket, decodeTicket, verifyLocalAttachment, type AttachmentChecks } from '../src/attachment.js';
import { attachmentStore, attachResolved, openSession, resolveAttachment, terminalCommand, terminalScript } from '../src/open.js';
import { handleRequest } from '../src/protocol.js';
import { controlServer } from '../src/transport.js';
import { processIdentity } from '../src/pi/runtime.js';

function fixture() {
  const root = fixtureRoot(); const store = new Store(join(root, 'destination')); const source = new Store(join(root, 'source'));
  const id = randomUUID(); const lineageId = randomUUID(); const hash = 'a'.repeat(64); const profile = fixtureProfile(root);
  const manifest = Manifest.parse({ protocol: 1, transferId: id, lineageId, parentTransfer: null, generation: 1, created: new Date().toISOString(), agent: 'pi', piVersion: '0.85.1', destination: 'exact-host', source: { repository: '/source', cwd: '/source' }, target: { repository: join(store.root, 'runs', id, 'workspace', 'worktree'), cwd: join(store.root, 'runs', id, 'workspace', 'worktree') }, instruction: 'must never replay', workspace: { head: 'a'.repeat(40), bundle: hash, index: [], files: [], excluded: [], historySensitive: [], historyApproved: [], sensitiveApproved: [] }, native: { sessionId: randomUUID(), leaf: 'leaf', session: hash, profile: profile.profile, profileDigest: hash, runtimeSignature: hash, resources: [], artifacts: [], requirements: { provider: profile.profile.provider, model: profile.profile.model, credentialAvailable: true, executables: [], services: [] } }, blobs: [] });
  const digest = store.putManifest(manifest); source.putManifest(manifest);
  const token = `b${id.replaceAll('-', '')}`;
  const receipt: Receipt = { transferId: id, lineageId, generation: 1, digest, sessionId: randomUUID(), sessionFile: join(root, 'session.jsonl'), leaf: 'initial-leaf', nonce: randomUUID(), pid: process.pid, start: processIdentity(), target: token, socket: token, at: new Date().toISOString() };
  const reg: Registration = { ...{ lineageId, generation: 1, parentTransfer: id }, sessionId: receipt.sessionId, sessionFile: receipt.sessionFile, cwd: manifest.target.cwd, leaf: 'later-leaf', profileDigest: hash, runtimeSignature: hash, cleanShutdown: false, sessionHash: null, pid: receipt.pid, nonce: receipt.nonce, start: receipt.start, socket: join(root, 'control.sock'), profilePath: profile.path };
  store.setOwner({ lineageId, generation: 1, transferId: id, digest, state: 'owned' }); store.receipt(id, receipt); store.register(reg);
  source.setOwner({ lineageId, generation: 1, transferId: id, digest, state: 'fenced' }); source.update(id, { phase: 'active', ownership: 'fenced', receipt });
  const config: Config = { version: 1, hosts: { 'exact-host': { root: store.root, profileDigest: hash } }, profile: profile.path, localRoot: source.root, remoteRoot: store.root };
  const checks: AttachmentChecks = { processMatches: () => true, control: async () => ({ registration: reg, frozen: 'open' }), run: () => Buffer.from(`${token}\t${receipt.pid}\t0\n`) };
  return { root, store, source, id, manifest, receipt, reg, config, checks, verify: (s: Store, i: string, expected?: Receipt) => verifyLocalAttachment(s, i, expected, checks) };
}

test('open: exact local destination receipt routes without config hosts or SSH; --here only attaches', async () => {
  const f = fixture(); const commands: [string, string[]][] = [];
  try {
    const before = readFileSync(join(f.store.transfer(f.id), 'status.json')); const owner = f.store.owner(f.manifest.lineageId);
    const options = { config: { ...f.config, hosts: {} }, verify: f.verify, interactive: true, connect: () => { throw new Error('Local route must never use SSH'); }, run: async (file: string, args: string[]) => { commands.push([file, args]); } };
    const route = await resolveAttachment(f.id, f.store, options); assert.equal(route.alias, null);
    await openSession(f.id, true, f.store, options);
    assert.deepEqual(commands, [['tmux', ['-L', f.receipt.socket, 'attach-session', '-t', f.receipt.target]]]);
    assert.deepEqual(readFileSync(join(f.store.transfer(f.id), 'status.json')), before); assert.deepEqual(f.store.owner(f.manifest.lineageId), owner);
    const empty = new Store(join(f.root, 'empty-local'));
    assert.equal(attachmentStore(f.id, f.config, empty, false).root, f.store.root);
    assert.equal(attachmentStore(f.id, f.config, empty, true).root, empty.root, 'BAUBLE_STATE override is authoritative');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('open: exact outbound fence uses verified helper then SSH ticket, never runtime/activate/prompt', async () => {
  const f = fixture(); const operations: string[] = []; const commands: [string, string[]][] = [];
  try {
    const options = { config: f.config, interactive: true, connect: (alias: string) => { assert.equal(alias, 'exact-host'); return async (request: { operation: string; root: string; data: unknown }) => { operations.push(request.operation); assert.equal(request.root, f.store.root); assert.deepEqual(request.data, { id: f.id, digest: f.receipt.digest }); return f.verify(f.store, f.id); }; }, run: async (file: string, args: string[]) => { commands.push([file, args]); } };
    const before = readFileSync(join(f.source.transfer(f.id), 'status.json'));
    await openSession(f.id, true, f.source, options);
    assert.deepEqual(operations, ['attach', 'attach']); assert.equal(commands.length, 1);
    const [file, args] = commands[0]!; assert.equal(file, 'ssh'); assert.deepEqual(args.slice(0, 3), ['-t', '--', 'exact-host']);
    assert.match(args[3]!, /^bauble _attach [A-Za-z0-9_-]+$/);
    const ticket = AttachTicket.parse(decodeTicket(args[3]!.split(' ')[2]!)); assert.equal(ticket.root, f.store.root); assert.deepEqual(ticket.receipt, f.receipt);
    assert.deepEqual(readFileSync(join(f.source.transfer(f.id), 'status.json')), before);
    await assert.rejects(resolveAttachment(f.id, f.source, { ...options, connect: () => async () => ({ ...f.receipt, nonce: randomUUID() }) }), /different process/);
    await assert.rejects(resolveAttachment(f.id, f.source, { config: { ...f.config, hosts: { 'exact-host': { root: '/changed', profileDigest: f.receipt.digest } } } }), /storage no longer matches/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('open: rejects missing/stale receipts, generations, returned/closed/non-tmux and fenced sessions', async () => {
  const f = fixture();
  try {
    const status = f.store.status(f.id); const owner = f.store.owner(f.manifest.lineageId);
    for (const patch of [{ receipt: undefined }, { phase: 'returned' as const }, { execution: 'exited' as const }, { receipt: { ...f.receipt, generation: 2 } }, { receipt: { ...f.receipt, digest: 'b'.repeat(64) } }, { receipt: { ...f.receipt, socket: `b${randomUUID().replaceAll('-', '')}` } }]) {
      atomicWrite(join(f.store.transfer(f.id), 'status.json'), json({ ...status, ...patch }));
      await assert.rejects(f.verify(f.store, f.id));
    }
    atomicWrite(join(f.store.transfer(f.id), 'status.json'), json(status));
    for (const patch of [{ state: 'fenced' as const }, { state: 'frozen' as const }, { generation: 2 }, { transferId: randomUUID() }, { digest: 'b'.repeat(64) }]) {
      f.store.setOwner({ ...owner, ...patch }); await assert.rejects(f.verify(f.store, f.id));
    }
    f.store.setOwner(owner);
    await assert.rejects(verifyLocalAttachment(f.store, f.id, undefined, { ...f.checks, processMatches: () => false }), /process identity.*bauble pi --session/);
    await assert.rejects(verifyLocalAttachment(f.store, f.id, undefined, { ...f.checks, run: () => { throw new Error('no tmux'); } }), /No existing tmux.*bauble pi --session/);
    await assert.rejects(verifyLocalAttachment(f.store, f.id, undefined, { ...f.checks, run: () => Buffer.from(`${f.receipt.target}\t1\t0`) }), /pane\/process identity/);
    await assert.rejects(verifyLocalAttachment(f.store, f.id, undefined, { ...f.checks, control: async () => ({ registration: f.reg, frozen: 'frozen' }) }), /frozen or fenced/);
    f.store.register({ ...f.reg, nonce: randomUUID() }); await assert.rejects(f.verify(f.store, f.id), /registration identity/);
    f.store.register(f.reg);
    await assert.rejects(verifyLocalAttachment(f.store, f.id, undefined, { ...f.checks, control: async () => { f.store.setOwner({ ...owner, state: 'fenced' }); return { registration: f.reg, frozen: 'open' }; } }), /Ownership changed/);
    assert.throws(() => attachmentBinding(f.store, '../escape'));
    assert.throws(() => decodeTicket('$(touch x)')); assert.throws(() => decodeTicket('a'.repeat(32769)));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('open: missing or ambiguous registration gives recovery guidance without control, launch or attach', async () => {
  const f = fixture(); const calls: string[] = [];
  try {
    const before = readFileSync(join(f.store.transfer(f.id), 'status.json')); const owner = f.store.owner(f.manifest.lineageId);
    const checks: AttachmentChecks = { processMatches: () => { calls.push('process'); return true; }, control: async () => { calls.push('control'); return {}; }, run: () => { calls.push('tmux'); return Buffer.alloc(0); } };
    const verify = (store: Store, id: string, receipt?: Receipt) => verifyLocalAttachment(store, id, receipt, checks);
    const rejects = (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /runtime identity is uncertain/);
      assert.ok(error.message.includes(`bauble recover ${f.id}`)); assert.doesNotMatch(error.message, /bauble pi|adoption|Bare files/); return true;
    };
    rmSync(join(f.store.root, 'sessions'), { recursive: true });
    for (const ambiguous of [false, true]) {
      if (ambiguous) { f.store.register(f.reg); f.store.register({ ...f.reg, sessionFile: join(f.root, 'duplicate.jsonl') }); }
      await assert.rejects(openSession(f.id, true, f.store, { config: f.config, interactive: true, verify, run: async () => { calls.push('attach'); } }), rejects);
      await assert.rejects(handleRequest({ operation: 'attach', root: f.store.root, data: { id: f.id, digest: f.receipt.digest } }, { config: f.config, launch: async () => { calls.push('launch'); } }), rejects);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(readFileSync(join(f.store.transfer(f.id), 'status.json')), before); assert.deepEqual(f.store.owner(f.manifest.lineageId), owner);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('open: Terminal subprocess revalidates expected process and fence before any attach', async () => {
  const f = fixture();
  try {
    const options = { verify: f.verify, run: async () => { throw new Error('must not attach'); } };
    const route = await resolveAttachment(f.id, f.store, options);
    f.store.update(f.id, { receipt: { ...f.receipt, at: new Date(Date.now() + 1000).toISOString() } });
    await assert.rejects(attachResolved(route, f.store, options), /different process/);
    f.store.update(f.id, { receipt: f.receipt }); f.store.setOwner({ ...f.store.owner(f.manifest.lineageId), state: 'frozen' });
    await assert.rejects(attachResolved(route, f.store, options), /outbound fence/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('open: safe Terminal argv and effective config/state propagation with hostile path characters', async () => {
  const f = fixture();
  try {
    const route = await resolveAttachment(f.id, f.store, { verify: f.verify });
    const hostile = "spaces ' \" $HOME $(touch INJECTED) `touch INJECTED` ; & !\n";
    const configFile = join(f.root, hostile + 'config'); const state = join(f.root, hostile + 'state');
    route.ticket.root = state;
    const probe = join(f.root, hostile + 'probe.cjs');
    writeFileSync(probe, 'console.log(JSON.stringify({argv:process.argv.slice(2),config:process.env.BAUBLE_CONFIG,state:process.env.BAUBLE_STATE}))');
    const command = terminalCommand(route, configFile, process.execPath, probe);
    for (const shell of ['/bin/sh', '/bin/zsh'].filter(existsSync)) {
      const output = JSON.parse(run(shell, ['-c', command], { cwd: f.root }).toString());
      assert.equal(output.config, configFile); assert.equal(output.state, state); assert.equal(output.argv[0], '_open'); assert.deepEqual(decodeTicket(output.argv[1]), route);
    }
    assert.equal(existsSync(join(f.root, 'INJECTED')), false, 'Shell characters stay data');
    const calls: [string, string[]][] = [];
    await openSession(f.id, false, f.store, { verify: f.verify, platform: 'darwin', configFile, run: async (file, args) => { calls.push([file, args]); } });
    assert.equal(calls[0]![0], '/usr/bin/osascript'); assert.deepEqual(calls[0]![1].slice(0, 4), ['-e', terminalScript, '--', terminalCommand(await resolveAttachment(f.id, f.store, { verify: f.verify }), configFile)]);
    assert.equal(terminalScript.includes(configFile), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('open: actionable headless/TTY/window errors, and CLI usage', async () => {
  const f = fixture();
  try {
    const options = { verify: f.verify, run: async () => { throw new Error('GUI unavailable'); } };
    await assert.rejects(openSession(f.id, false, f.store, { ...options, platform: 'linux' }), /Linux\/headless.*--here/);
    await assert.rejects(openSession(f.id, true, f.store, { ...options, interactive: false }), /interactive terminal.*ssh -t/);
    await assert.rejects(openSession(f.id, false, f.store, { ...options, platform: 'darwin' }), /Could not open Terminal.app.*--here/);
    assert.match(run(process.execPath, ['dist/src/cli.js', 'open', '--help']).toString(), /--here/);
    assert.throws(() => run(process.execPath, ['dist/src/cli.js', 'attach', f.id, '--here']), /USAGE/);
    await assert.rejects(openSession('not-an-id', true, f.store, { ...options, interactive: true }));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('open: actual isolated tmux pane PID plus control receipt verifies; replaced pane and helper fence fail closed', async () => {
  const f = fixture(); let server: Awaited<ReturnType<typeof controlServer>> | undefined;
  try {
    run('tmux', ['-L', f.receipt.socket, '-f', '/dev/null', 'new-session', '-d', '-s', f.receipt.target, process.execPath, '-e', 'setInterval(()=>{},1000)']);
    const pid = Number(run('tmux', ['-L', f.receipt.socket, 'display-message', '-p', '-t', f.receipt.target, '#{pane_pid}']).toString());
    const receipt = { ...f.receipt, pid, start: processIdentity(pid) }; const reg = { ...f.reg, pid, start: receipt.start };
    f.store.register(reg); f.store.receipt(f.id, receipt);
    server = await controlServer(reg.socket, async () => ({ registration: reg, frozen: 'open' }));
    const before = readFileSync(join(f.store.transfer(f.id), 'status.json'));
    const request = { operation: 'attach' as const, root: f.store.root, data: { id: f.id, digest: receipt.digest } };
    assert.deepEqual(await handleRequest(request, { config: f.config, launch: async () => { throw new Error('must not launch'); } }), receipt);
    assert.deepEqual(readFileSync(join(f.store.transfer(f.id), 'status.json')), before);
    f.store.setOwner({ ...f.store.owner(f.manifest.lineageId), state: 'fenced' });
    await assert.rejects(handleRequest(request, { config: f.config }), /fenced/);
    f.store.setOwner({ ...f.store.owner(f.manifest.lineageId), state: 'owned' });
    run('tmux', ['-L', receipt.socket, 'respawn-pane', '-k', '-t', receipt.target, process.execPath, '-e', 'setInterval(()=>{},1000)']);
    await assert.rejects(verifyLocalAttachment(f.store, f.id), /process identity|pane\/process identity/);
  } finally {
    server?.close(); try { run('tmux', ['-L', f.receipt.socket, 'kill-server']); } catch { /* Only this test's isolated tmux server. */ }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('log CLI: finite JSON and ordered follow NDJSON, then terminal interruption without state changes', async () => {
  const f = fixture(); const path = join(f.store.transfer(f.id), 'run.log'); writeFileSync(path, 'first α\n');
  const configPath = join(f.root, 'log-config.json'); atomicWrite(configPath, json(f.config));
  const env = { ...process.env, BAUBLE_STATE: f.store.root, BAUBLE_CONFIG: configPath };
  try {
    const before = readFileSync(join(f.store.transfer(f.id), 'status.json'));
    const finite = spawnSync(process.execPath, ['dist/src/cli.js', 'log', f.id, '--json'], { env, encoding: 'utf8' }); assert.equal(finite.status, 0, finite.stderr); assert.equal(JSON.parse(finite.stdout).data.text, 'first α\n');
    const child = spawn(process.execPath, ['dist/src/cli.js', 'log', f.id, '--follow', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const values: Array<{ ok: boolean; data: { sequence?: number; text?: string }; error: { code: string } | null }> = []; let pending = ''; let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.stdout.on('data', bytes => { pending += bytes.toString(); const lines = pending.split('\n'); pending = lines.pop()!; for (const line of lines) { const value = JSON.parse(line); values.push(value); if (value.ok && value.data.sequence === 0) appendFileSync(path, 'second 🙂\n'); if (value.ok && value.data.text === 'second 🙂\n') child.kill('SIGINT'); } });
    const code = await new Promise<number | null>((ok, fail) => { child.on('error', fail); child.on('exit', ok); }); clearTimeout(timer);
    assert.equal(code, 130, stderr); assert.equal(values[0]!.data.text, 'first α\n'); assert.equal(values[1]!.data.text, 'second 🙂\n'); assert.equal(values[1]!.data.sequence, 1); assert.equal(values.at(-1)!.error!.code, 'INTERRUPTED'); assert.deepEqual(readFileSync(join(f.store.transfer(f.id), 'status.json')), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
