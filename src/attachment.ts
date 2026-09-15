import { loadConfig } from './config.js';
import { targetRepository } from './targets.js';
import { z } from 'zod';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { Digest, Id, Receipt, Registration, type Config } from './schema.js';
import { invariant, json, run } from './safe.js';
import { processMatches } from './process.js';
import { control } from './transport.js';

export const reopenGuidance = 'Open/attach never starts Pi. For missing or uncertain receipts, run bauble recover <transfer-id>. For a closed remote session, use bauble pull <transfer-id>, then explicitly run its printed bauble pi --session command. For returned or closed local sessions, explicitly use bauble pi --session <verified-registered-path> only after confirming local ownership and old runtime shutdown.';
export function attachmentBinding(store: Store, id: string) {
  Id.parse(id);
  const { manifest, digest } = store.manifest(id); const status = store.status(id); const owner = store.owner(manifest.lineageId);
  invariant(status.transferId === id && status.digest === digest, 'Attachment status binding mismatch');
  invariant(!['returned', 'cancelled'].includes(status.phase), `Transfer is ${status.phase}; ${reopenGuidance}`);
  invariant(owner.transferId === id && owner.digest === digest && owner.generation === manifest.generation, `Stale attachment owner/transfer/digest/generation; ${reopenGuidance}`);
  invariant(status.receipt, `Missing readiness receipt; ${reopenGuidance}`);
  const receipt = status.receipt;
  invariant(receipt.transferId === id && receipt.digest === digest && receipt.lineageId === manifest.lineageId && receipt.generation === manifest.generation, 'Attachment receipt binding mismatch');
  const token = `b${id.replaceAll('-', '')}`;
  invariant(receipt.socket === token && receipt.target === token, 'Attachment tmux identity mismatch');
  return { manifest, digest, status, owner, receipt };
}
export function sameReceipt(actual: Receipt, expected: Receipt) {
  invariant(json(actual) === json(expected), 'Readiness receipt changed; refusing a different process');
}
export function registrationMatches(reg: Registration, receipt: Receipt) {
  invariant(reg.parentTransfer === receipt.transferId && reg.lineageId === receipt.lineageId && reg.generation === receipt.generation && reg.sessionId === receipt.sessionId && reg.sessionFile === receipt.sessionFile && reg.pid === receipt.pid && reg.start === receipt.start && reg.nonce === receipt.nonce && !reg.cleanShutdown, `Runtime registration identity changed or closed; ${reopenGuidance}`);
}
export interface AttachmentChecks { processMatches: typeof processMatches; control: typeof control; run: typeof run }
export async function verifyLocalAttachment(store: Store, id: string, expected?: Receipt, checks: AttachmentChecks = { processMatches, control, run }) {
  const { manifest, status, owner, receipt } = attachmentBinding(store, id);
  invariant(owner.state === 'owned' && status.ownership === 'destination' && status.phase === 'active', `Local runtime is fenced, frozen or not active; ${reopenGuidance}`);
  invariant(manifest.target.repository === targetRepository(manifest, store.root, manifest.codeRoot ? loadConfig().codeRoot : undefined), 'Local destination storage binding mismatch');
  invariant(!['exited', 'failed'].includes(status.execution), `Runtime is closed or failed; ${reopenGuidance}`);
  if (expected) sameReceipt(receipt, expected);
  let reg: Registration;
  try { reg = store.registration(receipt.sessionId); }
  catch { throw new Error(`Runtime registration is missing, ambiguous or unreadable; runtime identity is uncertain. Open/attach never starts Pi. Run bauble recover ${id} before attempting attachment.`); }
  registrationMatches(reg, receipt);
  invariant(checks.processMatches(receipt), `No verified live process identity; ${reopenGuidance}`);
  let observed: unknown;
  try { observed = await checks.control(reg.socket, { operation: 'observe' }); }
  catch { throw new Error(`Existing runtime control channel is unavailable; ${reopenGuidance}`); }
  const observation = z.object({ registration: Registration, frozen: z.string() }).passthrough().parse(observed);
  invariant(observation.frozen === 'open', `Runtime is frozen or fenced; ${reopenGuidance}`);
  registrationMatches(observation.registration, receipt);
  // launchTmux execs the runtime as the pane process. A name alone could refer to a replacement pane.
  let panes: string;
  try { panes = checks.run('tmux', ['-L', receipt.socket, 'list-panes', '-s', '-t', receipt.target, '-F', '#{session_name}\t#{pane_pid}\t#{pane_dead}']).toString().trim(); }
  catch { throw new Error(`No existing tmux terminal for this runtime; ${reopenGuidance}`); }
  invariant(panes === `${receipt.target}\t${receipt.pid}\t0`, `tmux pane/process identity mismatch (non-tmux sessions cannot be opened); ${reopenGuidance}`);
  // Re-read the durable fence after the asynchronous control round trip.
  const current = attachmentBinding(store, id);
  invariant(current.owner.state === 'owned' && current.status.phase === 'active' && current.status.ownership === 'destination', `Ownership changed during attachment; ${reopenGuidance}`);
  sameReceipt(current.receipt, receipt);
  return receipt;
}
export const AttachTicket = z.object({ id: Id, digest: Digest, root: z.string().max(4096), receipt: Receipt }).strict();
export type AttachTicket = z.infer<typeof AttachTicket>;
export function encodeTicket(value: unknown) { return Buffer.from(json(value)).toString('base64url'); }
export function decodeTicket(value: string): unknown {
  invariant(value.length <= 32768 && /^[A-Za-z0-9_-]+$/.test(value), 'Invalid attachment ticket');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}
export function authorizedAttachmentRoot(root: string, config: Config) {
  const configured = resolve(config.remoteRoot); root = resolve(root);
  invariant(root === configured || (root.startsWith(join(configured, 'fixtures') + '/') && Id.safeParse(root.slice(join(configured, 'fixtures').length + 1)).success), 'Remote root must match configured storage or an explicitly authorized UUID fixture');
  return root;
}
