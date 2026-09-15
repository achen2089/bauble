import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { Store } from './store.js';
import { atomicWrite, json } from './safe.js';
import { CliError } from './errors.js';
import { approvalActions, type OperationContext, type Prepared } from './output.js';
export function prepared(store: Store, id: string, sourceFrozen: boolean): Prepared { const { manifest, digest } = store.manifest(id); return { prepared: true, transferId: id, digest, checkpoint: store.transfer(id), destination: manifest.destination, sourceFrozen }; }
export async function approve(store: Store, id: string, explicit?: string, dialog?: (text: string) => Promise<boolean>, autoApprove = false, context: OperationContext = {}) {
  const { manifest, digest } = store.manifest(id);
  if (explicit !== undefined) { if (explicit !== digest) throw new CliError('APPROVAL_MISMATCH', 'Approval does not match the immutable digest and destination.', 'approval', 'Inspect this exact snapshot again.', prepared(store, id, manifest.destination !== 'local' && manifest.native.session !== null), approvalActions(id, digest)); store.approve(id, digest); return; }
  if (autoApprove) { store.approve(id, digest); atomicWrite(join(store.transfer(id), 'autoapproval.json'), json({ id, digest, destination: manifest.destination, scope: 'this immutable snapshot only' })); return; }
  if (!dialog && !(context.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) throw new CliError('APPROVAL_REQUIRED', 'Exact immutable inventory approval is required; no dispatch or ownership release occurred.', 'approval', 'Inspect, obtain authorization, approve, then recover the existing ID. Do not repeat capture.', prepared(store, id, manifest.destination !== 'local' && manifest.native.session !== null), approvalActions(id, digest));
  const { approvalText } = await import('./checkpoint.js'); const text = approvalText(manifest, digest);
  let accepted: boolean;
  if (dialog) accepted = await dialog(text);
  else { process.stderr.write(text + '\n'); const input = createInterface({ input: process.stdin, output: process.stderr }); try { accepted = await input.question('Approve this exact digest and destination? Type the full digest: ') === digest; } finally { input.close(); } }
  if (!accepted) throw new CliError('APPROVAL_REQUIRED', 'Transfer not approved; any source freeze remains until explicit recovery/cancellation.', 'approval', null, prepared(store, id, manifest.destination !== 'local' && manifest.native.session !== null), approvalActions(id, digest));
  store.approve(id, digest);
}
