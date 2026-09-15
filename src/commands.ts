import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { Config, Manifest, Registration, Alias, Id } from './schema.js';
import { loadConfig, saveConfig, selectHost } from './config.js';
import { captureCheckpoint, captureOffline, approvalText } from './checkpoint.js';
import { sendCheckpoint, cancelTransfer, recoverOutbound } from './protocol.js';
import { control, controlServer, ssh, type Rpc } from './transport.js';
import { atomicWrite, hash, invariant, json, readBytes, readJson, removeFile } from './safe.js';
import { createManaged, processIdentity, processMatches, type Managed } from './pi/runtime.js';
import { readProfile, snapshotProfile } from './pi/profile.js';
import { terminal } from './pi/terminal.js';
import { beginReturn, findReturn, resumeReturn } from './return.js';
import { attachResolved, resolveAttachment } from './open.js';
import { acceptMessage, MESSAGE_CAPABILITY, MessageSubmission } from './message.js';

export async function approve(store: Store, id: string, explicit?: string, dialog?: (text: string) => Promise<boolean>) {
  const { manifest, digest } = store.manifest(id); const text = approvalText(manifest, digest);
  if (explicit !== undefined) { invariant(explicit === digest, 'Explicit approval digest does not match this immutable manifest/destination'); store.approve(id, digest); return; }
  if (dialog) invariant(await dialog(text), 'Transfer not approved; source remains frozen until explicit recovery/cancellation');
  else { console.log(text); invariant(process.stdin.isTTY && process.stdout.isTTY, `Interactive approval required; inspect checkpoint and supply --approval-digest ${digest} (no --yes)`); const input = createInterface({ input: process.stdin, output: process.stdout }); try { invariant(await input.question('Approve this exact digest and destination? Type the full digest: ') === digest, 'Transfer not approved'); } finally { input.close(); } }
  store.approve(id, digest);
}
export async function setup(alias: string, makeDefault: boolean) {
  Alias.parse(alias); const config = loadConfig(); const store = new Store();
  const profile = readProfile(config.profile); const digest = snapshotProfile(profile, dirname(config.profile), store.blobs).digest;
  const result = z.object({ protocol: z.literal(1), version: z.literal('0.1.0'), piVersion: z.literal('0.85.1'), profileDigest: z.string(), root: z.string() }).passthrough().parse(await ssh(alias)({ operation: 'probe', root: config.remoteRoot, data: {} }));
  invariant(result.profileDigest === digest, 'Remote controlled profile differs; configure independently before setup');
  config.hosts[alias] = { root: result.root, profileDigest: digest }; if (!config.defaultHost || makeDefault) config.defaultHost = alias; saveConfig(config); console.log(`Configured ${alias}${config.defaultHost === alias ? ' (default)' : ''}`);
}
export async function captureSelected(store: Store, selected: string, destination: string, targetRoot: string, instruction?: string, sensitive?: string[], history?: string[]) {
  const reg = store.registration(selected);
  if (processMatches(reg)) return z.object({ manifest: Manifest, digest: z.string(), checkpoint: z.string() }).parse(await control(reg.socket, { operation: 'capture', destination, targetRoot, instruction: instruction ?? null, sensitive, history }));
  return captureOffline({ store, registration: reg, destination, targetRoot, instruction, sensitive, history });
}
export async function send(options: { session?: string; checkpoint?: string; host?: string; instructionFile?: string; approvalDigest?: string; sensitive?: string[]; history?: string[] }, store = new Store(), dialog?: (text: string) => Promise<boolean>) {
  const config = loadConfig(); invariant(Boolean(options.session) !== Boolean(options.checkpoint), 'Select exactly one --session or --checkpoint');
  let id: string; let alias: string;
  if (options.checkpoint) {
    invariant(!options.host && !options.instructionFile, 'Existing checkpoint retains destination, instruction and transfer ID');
    const directory = resolve(options.checkpoint); const manifest = readJson(join(directory, 'manifest.json'), Manifest); id = manifest.transferId; alias = selectHost(config, manifest.destination);
    if (directory !== store.transfer(id)) { const digest = store.putManifest(manifest); const approval = JSON.parse(readBytes(join(directory, 'approval.json')).toString()); invariant(approval.digest === digest && approval.destination === alias, 'Checkpoint lacks original matching approval'); for (const blob of manifest.blobs) invariant(store.blobs.put(readBytes(join(directory, 'blobs', blob.hash))) === blob.hash, 'Corrupt checkpoint'); store.approve(id, digest); }
    store.approved(id);
  } else {
    alias = selectHost(config, options.host); const instruction = options.instructionFile ? readBytes(options.instructionFile, 1024 * 1024).toString('utf8') : undefined;
    const captured = await captureSelected(store, options.session!, alias, config.hosts[alias]!.root, instruction, options.sensitive, options.history); id = captured.manifest.transferId;
    console.log(`Checkpoint: ${captured.checkpoint}\nDigest: ${captured.digest}`);
    await approve(store, id, options.approvalDigest, dialog);
  }
  const result = await sendCheckpoint(store, id, ssh(alias), config.hosts[alias]!.root); console.log(json(result));
  const reg = store.registration(store.manifest(id).manifest.native.sessionId);
  if (processMatches(reg)) await control(reg.socket, { operation: 'finish', id }); return result;
}
export async function captureLive(managed: Managed, store: Store, options: { destination: string; targetRoot: string; instruction?: string; sensitive?: string[]; history?: string[]; transferId?: string }) {
  // Reject a duplicate before entering rollback scope. It did not acquire the earlier freeze.
  managed.guard.check(); invariant(managed.guard.phase === 'open', 'Capture already pending');
  const before = store.owner(managed.registration.lineageId); const transferId = Id.parse(options.transferId ?? randomUUID());
  try {
    const reg = await managed.settled();
    return captureCheckpoint({ ...options, transferId, store, registration: reg, profile: managed.profile, live: managed.runtime.session });
  } catch (error) {
    const rolledBack = store.lock(managed.registration.lineageId, () => {
      const owner = store.owner(managed.registration.lineageId);
      if (!existsSync(join(store.transfer(transferId), 'manifest.json')) && (json(owner) === json(before) || json(owner) === json({ ...before, state: 'frozen' }))) {
        store.setOwner(before); return true;
      }
      return false;
    });
    if (rolledBack) managed.guard.phase = 'open';
    throw error;
  }
}
export async function hostRuntime(options: { session?: string; store: Store; profilePath: string; cwd: string; registration?: Registration; transferId?: string; interactive?: boolean; allowTest?: boolean }) {
  const { store } = options; let managed!: Managed;
  managed = await createManaged({ ...options, observe: execution => { if (options.transferId) { store.update(options.transferId, { execution }); store.event(options.transferId, { execution }); } }, handoff: async (host, dialog) => { await send({ session: managed.registration.sessionFile, host }, store, dialog); } });
  const socket = managed.registration.socket; removeFile(socket);
  const server = await controlServer(socket, async raw => {
    if (raw && typeof raw === 'object' && 'operation' in raw && raw.operation === 'message') {
      const { operation: _operation, ...submission } = z.object({ operation: z.literal('message'), ...MessageSubmission.shape }).strict().parse(raw);
      return acceptMessage(managed, store, submission);
    }
    const request = z.object({ operation: z.enum(['capture', 'finish', 'observe', 'unfreeze']), destination: Alias.optional(), targetRoot: z.string().optional(), instruction: z.string().nullable().optional(), sensitive: z.array(z.string()).optional(), history: z.array(z.string()).optional(), id: z.string().optional() }).strict().parse(raw);
    if (request.operation === 'observe') return { registration: managed.registration, idle: managed.runtime.session.isIdle, frozen: managed.guard.phase, capabilities: [MESSAGE_CAPABILITY] };
    if (request.operation === 'unfreeze') { managed.guard.unfreeze(); return { unfrozen: true }; }
    if (request.operation === 'finish') { const owner = store.owner(managed.registration.lineageId); invariant(owner.transferId === request.id && (owner.state === 'fenced' || (owner.state === 'owned' && store.status(request.id!).phase === 'cancelled')), 'Cannot finish an unfenced source'); setTimeout(() => { void managed.close().then(() => process.exit(0)); }, 100); return { closing: true }; }
    invariant(request.destination && request.targetRoot, 'Capture requires destination and root');
    return captureLive(managed, store, { destination: request.destination, targetRoot: request.targetRoot, instruction: request.instruction ?? undefined, sensitive: request.sensitive, history: request.history, transferId: request.id });
  });
  const close = managed.close.bind(managed); managed.close = async () => { server.close(); removeFile(socket); await close(); };
  if (options.transferId) {
    const id = options.transferId; const { manifest, digest } = store.manifest(id); const token = `b${id.replaceAll('-', '')}`;
    managed.runtime.session.subscribe(event => { store.event(id, { nativeEvent: event.type }); if (event.type === 'message_end') { const m = event.message; atomicWrite(join(store.transfer(id), 'run.log'), readBytesOrEmpty(join(store.transfer(id), 'run.log')) + json(managed.guard.messageReserved ? { role: m.role, contentOmitted: 'Bauble message; inspect the sensitive native transcript explicitly' } : m)); } });
    let mode: ReturnType<typeof terminal> | undefined;
    if (options.interactive !== false) { mode = terminal(managed.runtime); await mode.init(); }
    else await managed.runtime.session.bindExtensions({ mode: 'print' });
    store.receipt(id, { transferId: id, lineageId: manifest.lineageId, generation: manifest.generation, digest, sessionId: managed.registration.sessionId, sessionFile: managed.registration.sessionFile, leaf: managed.registration.leaf!, nonce: managed.registration.nonce, pid: process.pid, start: managed.registration.start, target: token, socket: token, at: new Date().toISOString() });
    if (manifest.instruction !== null) {
      store.update(id, { continuation: 'intent' });
      try { await managed.runtime.session.prompt(manifest.instruction, { expandPromptTemplates: false, preflightResult(accepted) { if (accepted) store.update(id, { continuation: 'accepted' }); } }); }
      catch (e) { store.update(id, { continuation: 'uncertain', execution: 'failed', error: String(e) }); }
    }
    if (mode) await mode.run();
  } else if (options.interactive !== false) await managed.run();
  return managed;
}
function readBytesOrEmpty(path: string) { return existsSync(path) ? readBytes(path).toString() : ''; }
export async function internalRuntime(id: string, root: string, interactive = true) {
  const store = new Store(root); const { manifest } = store.manifest(id); const status = store.status(id);
  invariant(status.phase === 'launch_intent' && !status.receipt, 'Runtime already started or lacks launch intent; never restart automatically');
  const restored = JSON.parse(readBytes(join(root, 'runs', id, 'restored.json')).toString());
  const registration: Registration = { ...restored, lineageId: manifest.lineageId, generation: manifest.generation, parentTransfer: id, profileDigest: manifest.native.profileDigest, runtimeSignature: manifest.native.runtimeSignature, cleanShutdown: true, sessionHash: hash(readBytes(restored.sessionFile)), pid: process.pid, nonce: randomUUID(), start: processIdentity(), socket: '' };
  try { return await hostRuntime({ store, profilePath: restored.profilePath, cwd: restored.cwd, registration, session: restored.sessionFile, transferId: id, interactive, allowTest: manifest.native.profile.testOnly }); }
  catch (e) { store.update(id, { phase: 'unknown', execution: 'failed', error: String(e) }); throw e; }
}
interface RecoveryOptions { config?: Config; connect?: (alias: string) => Rpc; approvalDigest?: string }
function returnedCommand(reg: Registration) { console.log(`Returned to ${reg.cwd}\nbauble pi --session ${JSON.stringify(reg.sessionFile)}\nProfile: ${reg.profilePath}`); }
export async function pull(id: string, approvalDigest?: string, store = new Store(), options: RecoveryOptions = {}) {
  const config = options.config ?? loadConfig(); const original = store.manifest(id); const alias = selectHost(config, original.manifest.destination); const root = config.hosts[alias]!.root;
  const route = beginReturn(store, id, alias, root); console.log(`Return recovery ID: ${route.reverseId}`);
  const reg = await resumeReturn(store, route, (options.connect ?? ssh)(alias), reverseId => approve(store, reverseId, approvalDigest));
  returnedCommand(reg); return reg;
}
export async function recover(id: string, cancel = false, store = new Store(), options: RecoveryOptions = {}) {
  const config = options.config ?? loadConfig(); const route = findReturn(store, id);
  if (route) {
    invariant(!cancel, 'Return cancellation is not automated; retain both checkpoints and reconcile the remote freeze/fence');
    const alias = selectHost(config, route.host); invariant(config.hosts[alias]!.root === route.remoteRoot, 'Return host storage configuration changed');
    const reg = await resumeReturn(store, route, (options.connect ?? ssh)(alias), reverseId => approve(store, reverseId, options.approvalDigest));
    returnedCommand(reg); return reg;
  }
  const { manifest, digest } = store.manifest(id); const alias = selectHost(config, manifest.destination); const rpc = (options.connect ?? ssh)(alias); const root = config.hosts[alias]!.root;
  if (cancel) {
    const owner = store.owner(manifest.lineageId);
    if (['captured', 'approved'].includes(store.status(id).phase) && owner.state === 'frozen' && owner.generation + 1 === manifest.generation && owner.transferId === id && owner.digest === digest) {
      store.lock(manifest.lineageId, () => { const current = store.owner(manifest.lineageId); invariant(current.state === 'frozen' && current.generation === owner.generation && current.transferId === id && current.digest === digest, 'Ownership changed'); store.update(id, { phase: 'cancelled', ownership: 'source' }); store.setOwner({ ...current, state: 'owned' }); });
      const reg = store.registration(manifest.native.sessionId); if (processMatches(reg)) await control(reg.socket, { operation: 'unfreeze' });
      console.log('Cancelled before authority was issued; source unfrozen.'); return;
    }
    await cancelTransfer(store, id, rpc, root); console.log('Positive destination revocation recorded. Source may be explicitly reopened after its old runtime exits.'); return;
  }
  await recoverOutbound(store, id, rpc, root);
  console.log(json(store.status(id)));
}
export async function attach(id: string, store = new Store()) {
  await attachResolved(await resolveAttachment(id, store), store);
}
