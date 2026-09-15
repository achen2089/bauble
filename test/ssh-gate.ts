import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fixtureRoot, fixtureRepo, fixtureProfile, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { loadConfig, selectHost } from '../src/config.js';
import { captureCheckpoint } from '../src/checkpoint.js';
import { createManaged } from '../src/pi/runtime.js';
import { sendCheckpoint } from '../src/protocol.js';
import { beginReturn, resumeReturn } from '../src/return.js';
import { recover } from '../src/commands.js';
import { ssh, type Rpc } from '../src/transport.js';
import { Alias, Receipt, Status } from '../src/schema.js';
import { invariant, json } from '../src/safe.js';

async function attachAndDetach(alias: string, receipt: Receipt) {
  Receipt.parse(receipt);
  await new Promise<void>((ok, fail) => {
    const child = spawn('ssh', ['-tt', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', alias, `tmux -L ${receipt.socket} attach-session -t ${receipt.target}`], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'xterm-256color' } });
    // Screen bytes are deliberately not used as execution evidence.
    child.stdout.resume(); let error = ''; child.stderr.on('data', b => error = (error + b).slice(-2000));
    const detach = setTimeout(() => child.stdin.write('\x02d'), 1500);
    const timeout = setTimeout(() => { child.kill(); fail(new Error('Attach/detach did not finish')); }, 15000);
    child.on('error', fail); child.on('close', code => { clearTimeout(detach); clearTimeout(timeout); code === 0 ? ok() : fail(new Error(`Attach failed ${code}: ${error}`)); });
  });
}
async function main() {
  const authorization = process.env.BAUBLE_TEST_SSH_HOST;
  invariant(authorization, 'BAUBLE_TEST_SSH_HOST is required to authorize isolated remote fixture activity. Gate FAILED, not skipped.');
  const alias = Alias.parse(authorization); const config = loadConfig(); selectHost(config, alias);
  const rpc = ssh(alias); const remoteBase = config.hosts[alias]!.root;
  await rpc({ operation: 'probe', root: remoteBase, data: {} });
  const remoteRoot = join(remoteBase, 'fixtures', randomUUID()); const localRoot = fixtureRoot();
  console.log(`Authorized SSH fixture: ${alias}\nLocal: ${localRoot}\nRemote: ${remoteRoot}`);
  const store = new Store(join(localRoot, 'state')); const repo = fixtureRepo(localRoot); const profile = fixtureProfile(localRoot); const native = fixtureSession(repo, localRoot);
  const originalIndex = readFileSync(join(repo, '.git/index')); const originalSession = readFileSync(native.manager.getSessionFile()!);
  const managed = await createManaged({ store, profilePath: profile.path, cwd: repo, manager: native.manager, allowTest: true });
  const reg = await managed.settled();
  const instruction = 'fixture:write {"path":"ssh-result.txt","content":"real SSH native Pi tool result"}';
  const checkpoint = captureCheckpoint({ store, registration: reg, profile: profile.profile, destination: alias, targetRoot: remoteRoot, instruction, live: managed.runtime.session });
  store.approve(checkpoint.manifest.transferId, checkpoint.digest); const id = checkpoint.manifest.transferId; const digest = checkpoint.digest;
  const dropAck: Rpc = async request => { const result = await rpc(request); if (request.operation === 'activate') throw new Error('SSH gate injected lost activation acknowledgment'); return result; };
  await assert.rejects(sendCheckpoint(store, id, dropAck, remoteRoot), /injected lost/); assert.equal(store.status(id).ownership, 'fenced');
  const request = { root: remoteRoot, data: { id, digest } };
  let observed = Status.parse(await rpc({ ...request, operation: 'status' }));
  for (let i = 0; i < 100 && (observed.execution !== 'idle' || observed.continuation !== 'accepted'); i++) { await new Promise(ok => setTimeout(ok, 100)); observed = Status.parse(await rpc({ ...request, operation: 'status' })); }
  assert.equal(observed.continuation, 'accepted'); assert.equal(observed.execution, 'idle'); const receipt = Receipt.parse(observed.receipt);
  const duplicate = Status.parse(await rpc({ ...request, operation: 'activate' })); assert.deepEqual(duplicate.receipt, receipt);
  const attached = Receipt.parse(await rpc({ ...request, operation: 'attach' })); assert.deepEqual(attached, receipt);
  await attachAndDetach(alias, receipt); await attachAndDetach(alias, receipt);
  assert.deepEqual(Receipt.parse(await rpc({ ...request, operation: 'attach' })), receipt, 'Reattachment must use exactly the same native process and tmux target');
  writeFileSync(join(repo, 'staged.txt'), 'newer original edit survives SSH return');
  // Reconcile the lost outbound acknowledgment through the public recovery implementation.
  const fixtureConfig = { ...config, hosts: { ...config.hosts, [alias]: { ...config.hosts[alias]!, root: remoteRoot } } };
  await recover(id, false, store, { config: fixtureConfig });
  assert.deepEqual(store.status(id).receipt, receipt);
  await managed.close();
  const route = beginReturn(store, id, alias, remoteRoot);
  const dropFenceAck: Rpc = async request => { const result = await rpc(request); if (request.operation === 'fence') throw new Error('SSH gate injected lost return fence acknowledgment'); return result; };
  await assert.rejects(resumeReturn(store, route, dropFenceAck, async reverseId => { store.approve(reverseId, store.manifest(reverseId).digest); }), { code: 'RETURN_UNCERTAIN' });
  const restored = await recover(route.reverseId, false, store, { config: fixtureConfig });
  assert.ok(restored && 'sessionFile' in restored); assert.equal(store.status(route.reverseId).phase, 'returned');
  assert.equal(store.owner(reg.lineageId).generation, 2);
  assert.equal(store.registration(restored.sessionFile).cleanShutdown, true);
  assert.equal(readFileSync(join(restored.cwd, 'ssh-result.txt'), 'utf8'), 'real SSH native Pi tool result');
  const reopened = SessionManager.open(restored.sessionFile);
  const messages = reopened.getEntries().filter(entry => entry.type === 'message').map(entry => entry.message);
  const submitted = messages.filter(message => message.role === 'user' && (typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('')) === instruction);
  assert.equal(submitted.length, 1, 'Exactly one literal continuation must be persisted');
  const calls = messages.flatMap(message => message.role === 'assistant' ? message.content.flatMap(part => part.type === 'toolCall' && part.name === 'write' && part.arguments.path === 'ssh-result.txt' ? [part] : []) : []);
  assert.equal(calls.length, 1, 'Recovery must not replay the write tool');
  assert.equal(messages.filter(message => message.role === 'toolResult' && message.toolCallId === calls[0]!.id && !message.isError).length, 1);
  assert.equal(reopened.getLeafId(), restored.leaf, 'Returned native active leaf survives reopening');
  assert.equal(readFileSync(join(repo, 'staged.txt'), 'utf8'), 'newer original edit survives SSH return'); assert.ok(readFileSync(join(repo, '.git/index')).equals(originalIndex)); assert.ok(readFileSync(native.manager.getSessionFile()!).equals(originalSession));
  // Finalized return recovery must be idempotent, with no new runtime or prompt.
  assert.deepEqual(await recover(route.reverseId, false, store, { config: fixtureConfig }), restored);
  let shutdown = Status.parse(await rpc({ ...request, operation: 'status' }));
  for (let i = 0; i < 20 && shutdown.execution !== 'exited'; i++) { await new Promise(ok => setTimeout(ok, 100)); shutdown = Status.parse(await rpc({ ...request, operation: 'status' })); }
  assert.equal(shutdown.execution, 'exited', 'Graceful return shutdown must be observed, not left idle');
  assert.deepEqual(shutdown.receipt, receipt);
  console.log(json({ passed: true, outbound: id, returned: route.reverseId, processReceipt: receipt, assertions: { attachDetachCycles: 2, sameProcessReceipt: true, lostActivationAcknowledgment: true, lostReturnFenceAcknowledgment: true, literalContinuations: submitted.length, writeToolCalls: calls.length, returnedCleanShutdown: true, remoteExecution: shutdown.execution, returnedLeaf: restored.leaf }, preservedFixtureRoots: [localRoot, remoteRoot] }));
}
main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
