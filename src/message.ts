import { CliError } from './errors.js';
import { targetRepository } from './targets.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Alias, Digest, Id, Receipt, Registration, type Config } from './schema.js';
import { Store } from './store.js';
import { atomicWrite, hash, invariant, json, privateDir, readJson, syncDir, withLock } from './safe.js';
import { attachmentBinding, registrationMatches, sameReceipt } from './attachment.js';
import { loadConfig } from './config.js';
import { control, ssh, type Rpc } from './transport.js';
import type { Managed } from './pi/runtime.js';
import { processMatches } from './process.js';

export const MESSAGE_CAPABILITY = 'message-v1';
export const messageCapabilityError = 'Existing helper/runtime lacks message-v1 capability or cannot verify it. Install a compatible Bauble build on both ends for future launches; an already-running older Pi cannot be upgraded in place. No automatic restart or delivery.';
export const MAX_TEXT = 64 * 1024;
export const MessageText = z.string().min(1).max(MAX_TEXT).refine(text => Buffer.byteLength(text) <= MAX_TEXT && !text.includes('\0') && Buffer.from(text).toString('utf8') === text, 'Message must be nonempty UTF-8, without NUL, at most 64 KiB');
export const MessageQuery = z.object({ requestId: Id, receipt: Receipt, textDigest: Digest.optional() }).strict();
export type MessageQuery = z.infer<typeof MessageQuery>;
export const MessageSubmission = z.object({ requestId: Id, receipt: Receipt, textDigest: Digest, text: MessageText }).strict();
export type MessageSubmission = z.infer<typeof MessageSubmission>;
const MessageRecord = z.object({ requestId: Id, receipt: Receipt, textDigest: Digest, state: z.enum(['intent', 'accepted', 'rejected']), reason: z.enum(['busy', 'preflight']).optional() }).strict();
type MessageRecord = z.infer<typeof MessageRecord>;
export const MessageResult = z.object({ requestId: Id, receipt: Receipt, textDigest: Digest.nullable(), state: z.enum(['accepted', 'rejected', 'uncertain', 'absent']), reason: z.enum(['busy', 'preflight', 'missing-receipt', 'delivery-unknown']).optional(), task: z.literal('not-tracked') }).strict();
export type MessageResult = z.infer<typeof MessageResult>;
const Dispatch = z.object({ requestId: Id, receipt: Receipt, textDigest: Digest, alias: Alias.nullable(), root: z.string() }).strict();
type Dispatch = z.infer<typeof Dispatch>;
const inboxPath = (store: Store, requestId: string) => join(store.root, 'message-inbox', `${Id.parse(requestId)}.json`);
const outboxPath = (store: Store, requestId: string) => join(store.root, 'message-outbox', `${Id.parse(requestId)}.json`);
function prepareLedger(store: Store, ledger: 'message-inbox' | 'message-outbox') {
  privateDir(join(store.root, ledger));
  // Repeat even for an existing directory: a prior creator may have failed this barrier.
  syncDir(store.root);
}
function matchQuery(record: MessageQuery, query: MessageQuery) {
  invariant(record.requestId === query.requestId, 'Message request ID mismatch');
  sameReceipt(record.receipt, query.receipt);
  invariant(query.textDigest === undefined || record.textDigest === query.textDigest, 'Request ID already bound to different text digest');
}
function result(record: MessageRecord): MessageResult {
  return { ...record, state: record.state === 'intent' ? 'uncertain' : record.state, task: 'not-tracked' };
}
export function messageStatusLocal(store: Store, raw: unknown): MessageResult {
  const query = MessageQuery.parse(raw);
  invariant(store.manifest(query.receipt.transferId).digest === query.receipt.digest, 'Message manifest digest changed');
  const path = inboxPath(store, query.requestId);
  if (!existsSync(path)) return { ...query, textDigest: query.textDigest ?? null, state: 'absent', reason: 'missing-receipt', task: 'not-tracked' };
  const record = readJson(path, MessageRecord); matchQuery(record, query); return result(record);
}
/** No tmux requirement: the exact managed process, not its terminal, accepts input. */
export function messageRuntimeBinding(store: Store, receipt: Receipt) {
  const bound = attachmentBinding(store, receipt.transferId); sameReceipt(bound.receipt, receipt);
  invariant(bound.owner.state === 'owned' && bound.status.phase === 'active' && bound.status.ownership === 'destination', 'Message destination is not the active owner (frozen/fenced/stale)');
  invariant(bound.manifest.target.repository === targetRepository(bound.manifest, store.root, bound.manifest.codeRoot ? loadConfig().codeRoot : undefined), 'Message destination storage changed');
  invariant(!['exited', 'failed'].includes(bound.status.execution), 'Message runtime is closed or failed; no restart');
  let reg: Registration;
  try { reg = store.registration(receipt.sessionId); } catch { throw new Error(`Missing or ambiguous message runtime registration; run bauble recover ${receipt.transferId}; no launch`); }
  registrationMatches(reg, receipt);
  invariant(processMatches(receipt), 'Message process identity is not live; no launch');
  return reg;
}
export async function checkMessageRuntime(store: Store, receipt: Receipt) {
  const reg = messageRuntimeBinding(store, receipt);
  let raw: unknown;
  try { raw = await control(reg.socket, { operation: 'observe' }); } catch { throw new CliError('CAPABILITY', messageCapabilityError, 'capability'); }
  const observation = z.object({ registration: Registration, frozen: z.string(), capabilities: z.array(z.string()).optional() }).passthrough().parse(raw);
  if (!observation.capabilities?.includes(MESSAGE_CAPABILITY)) throw new CliError('CAPABILITY', messageCapabilityError, 'capability');
  invariant(observation.frozen === 'open', 'Message runtime is frozen or fenced');
  registrationMatches(observation.registration, receipt);
  messageRuntimeBinding(store, receipt);
  return { capability: MESSAGE_CAPABILITY, receipt };
}
export async function deliverMessageLocal(store: Store, raw: unknown) {
  const submission = MessageSubmission.parse(raw);
  invariant(hash(submission.text) === submission.textDigest, 'Message text digest mismatch');
  await checkMessageRuntime(store, submission.receipt);
  const reg = messageRuntimeBinding(store, submission.receipt);
  return control(reg.socket, { operation: 'message', ...submission });
}
/** Called only in the already-running guarded host; persist intent before native prompt. */
export async function acceptMessage(managed: Managed, store: Store, raw: unknown): Promise<MessageResult> {
  const submission = MessageSubmission.parse(raw);
  invariant(hash(submission.text) === submission.textDigest, 'Message text digest mismatch');
  const { requestId, receipt, textDigest } = submission;
  const path = inboxPath(store, requestId);
  const validate = () => {
    messageRuntimeBinding(store, receipt);
    registrationMatches(managed.registration, receipt);
    invariant(managed.runtime.session.sessionId === receipt.sessionId && managed.runtime.session.sessionFile === receipt.sessionFile && receipt.pid === process.pid, 'Message live session identity changed');
  };
  // The UUID namespace is store-global, including different transfers in separate hosts.
  // Hold the interprocess lock only through the initial durable binding, never native preflight.
  const admission = withLock(join(store.root, 'message-inbox-locks', requestId), () => {
    const previous = messageStatusLocal(store, submissionQuery(submission));
    if (previous.state !== 'absent') return { previous };
    validate();
    invariant(managed.guard.phase === 'open', 'Message runtime is frozen or settling');
    prepareLedger(store, 'message-inbox');
    let reservation: ReturnType<Managed['guard']['reserveMessage']>;
    try { reservation = managed.guard.reserveMessage(managed.runtime.session); }
    catch {
      const record: MessageRecord = { requestId, receipt, textDigest, state: 'rejected', reason: 'busy' };
      atomicWrite(path, json(record)); return { previous: result(record) };
    }
    try { atomicWrite(path, json({ requestId, receipt, textDigest, state: 'intent' } satisfies MessageRecord)); }
    catch (error) { reservation.release(); throw error; }
    return { reservation };
  });
  if (admission.previous) return admission.previous;
  const reservation = admission.reservation!;
  return reservation.run(async () => {
    let record: MessageRecord = { requestId, receipt, textDigest, state: 'intent' };
    let acknowledge!: (value: MessageResult) => void;
    const acknowledgment = new Promise<MessageResult>(ok => { acknowledge = ok; });
    try {
      // The pinned callback runs synchronously before _runAgentPrompt. Throwing here prevents that call.
      const running = managed.runtime.session.prompt(submission.text, { expandPromptTemplates: false, source: 'rpc', preflightResult(accepted) {
        validate(); managed.guard.check();
        const next: MessageRecord = { ...record, state: accepted ? 'accepted' : 'rejected', ...(accepted ? {} : { reason: 'preflight' as const }) };
        atomicWrite(path, json(next)); record = next; acknowledge(result(record));
      } });
      void (async () => {
        try { await running; }
        catch { /* No raw prompt/provider errors in receipts or logs. Intent remains uncertain. */ }
        finally {
          try { await managed.runtime.session.waitForIdle(); }
          catch { managed.guard.phase = 'frozen'; }
          finally { reservation.release(); acknowledge(result(record)); }
        }
      })();
    } catch {
      reservation.release();
      // Persistence can fail after rename: never infer that delivery is safe to retry.
      return { requestId, receipt, textDigest, state: 'uncertain', reason: 'delivery-unknown', task: 'not-tracked' };
    }
    return acknowledgment;
  });
}
function submissionQuery(value: MessageSubmission): MessageQuery { return { requestId: value.requestId, receipt: value.receipt, textDigest: value.textDigest }; }
interface MessageOptions { config?: Config; connect?: (alias: string) => Rpc; onIntent?: (requestId: string) => void }
function routeMessage(store: Store, id: string, config: Config) {
  const binding = attachmentBinding(store, Id.parse(id));
  if (binding.owner.state === 'owned' && binding.status.ownership === 'destination') return { alias: null, root: resolve(store.root), receipt: binding.receipt };
  invariant((binding.owner.state === 'fenced' || binding.owner.state === 'dispatched') && binding.status.ownership === 'fenced', 'No exact message owner or outbound fence');
  const alias = Alias.parse(binding.manifest.destination); const host = config.hosts[alias];
  invariant(host && binding.manifest.target.repository === targetRepository(binding.manifest, host.root, host.codeRoot), 'Message destination SSH configuration/root changed');
  return { alias, root: resolve(host.root), receipt: binding.receipt };
}
function rpcFor(dispatch: Pick<Dispatch, 'alias' | 'root' | 'receipt'>, options: MessageOptions, store: Store): Rpc {
  if (dispatch.alias === null) {
    invariant(resolve(store.root) === dispatch.root, 'Local message root changed');
    return async request => request.operation === 'message-status' ? messageStatusLocal(store, request.data) : request.operation === 'message-check' ? checkMessageRuntime(store, dispatch.receipt) : deliverMessageLocal(store, request.data);
  }
  const config = options.config ?? loadConfig();
  invariant(config.hosts[dispatch.alias] && resolve(config.hosts[dispatch.alias]!.root) === dispatch.root, 'Message SSH destination configuration changed');
  return (options.connect ?? ssh)(dispatch.alias);
}
function checkedResult(raw: unknown, query: MessageQuery) {
  const value = MessageResult.parse(raw); sameReceipt(value.receipt, query.receipt);
  invariant(value.requestId === query.requestId && (query.textDigest === undefined || value.textDigest === query.textDigest), 'Message acknowledgment binding mismatch'); return value;
}
async function reconcileMessage(store: Store, dispatch: Dispatch, options: MessageOptions) {
  const query = { requestId: dispatch.requestId, receipt: dispatch.receipt, textDigest: dispatch.textDigest };
  try {
    const value = checkedResult(await rpcFor(dispatch, options, store)({ operation: 'message-status', root: dispatch.root, data: query }), query);
    return value.state === 'absent' ? { ...value, state: 'uncertain' as const } : value;
  } catch { return { ...query, state: 'uncertain' as const, reason: 'delivery-unknown' as const, task: 'not-tracked' as const }; }
}
export async function messageSession(id: string, text: string, requestId: string = randomUUID(), store = new Store(), options: MessageOptions = {}): Promise<MessageResult> {
  Id.parse(id); Id.parse(requestId); MessageText.parse(text);
  const path = outboxPath(store, requestId); const textDigest = hash(text);
  if (existsSync(path)) {
    const previous = readJson(path, Dispatch);
    invariant(previous.receipt.transferId === id && previous.textDigest === textDigest, 'Request ID already bound to a different transfer/text digest');
    return reconcileMessage(store, previous, options);
  }
  const config = options.config ?? loadConfig(); const route = routeMessage(store, id, config);
  const dispatch = Dispatch.parse({ requestId, textDigest, ...route }); const rpc = rpcFor(dispatch, options, store);
  let ready: unknown;
  try { ready = await rpc({ operation: 'message-check', root: dispatch.root, data: { receipt: dispatch.receipt } }); }
  catch (error) { throw new Error(`${messageCapabilityError} ${error instanceof Error ? error.message : 'Verification failed'}`); }
  const capability = z.object({ capability: z.literal(MESSAGE_CAPABILITY), receipt: Receipt }).strict().parse(ready); sameReceipt(capability.receipt, dispatch.receipt);
  invariant(json(routeMessage(store, id, config)) === json(route), 'Message route/owner changed before intent');
  const created = withLock(join(store.root, 'message-locks', requestId), () => {
    if (existsSync(path)) { invariant(json(readJson(path, Dispatch)) === json(dispatch), 'Request ID already bound to a different payload/route'); return false; }
    prepareLedger(store, 'message-outbox');
    atomicWrite(path, json(dispatch)); return true;
  });
  if (!created) return reconcileMessage(store, dispatch, options);
  options.onIntent?.(requestId);
  try {
    return checkedResult(await rpc({ operation: 'message', root: dispatch.root, data: { requestId, receipt: dispatch.receipt, textDigest, text } }), { requestId, receipt: dispatch.receipt, textDigest });
  } catch { return { requestId, receipt: dispatch.receipt, textDigest, state: 'uncertain', reason: 'delivery-unknown', task: 'not-tracked' }; }
}
export async function messageStatus(id: string, requestId: string, store = new Store(), options: MessageOptions = {}): Promise<MessageResult> {
  Id.parse(id); Id.parse(requestId); const path = outboxPath(store, requestId);
  if (existsSync(path)) { const dispatch = readJson(path, Dispatch); invariant(dispatch.receipt.transferId === id, 'Message request belongs to another transfer'); return reconcileMessage(store, dispatch, options); }
  // Destination-side historical lookup needs no live process and never changes receipts or ownership.
  const inbox = inboxPath(store, requestId);
  if (existsSync(inbox)) { const record = readJson(inbox, MessageRecord); invariant(record.receipt.transferId === id, 'Message request belongs to another transfer'); return messageStatusLocal(store, { requestId, receipt: record.receipt }); }
  const route = routeMessage(store, id, options.config ?? loadConfig()); const query = { requestId, receipt: route.receipt };
  return checkedResult(await rpcFor(route, options, store)({ operation: 'message-status', root: route.root, data: query }), query);
}
