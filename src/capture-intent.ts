import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Alias, Digest, Id, Registration } from './schema.js';
import { Store } from './store.js';
import { atomicWrite, hash, invariant, json, readJson, privateDir, syncDir } from './safe.js';
import { CliError } from './errors.js';

const CaptureIntent = z.object({ version: z.literal(1), transferId: Id, source: Registration, destination: Alias, targetRoot: z.string(), instructionDigest: Digest.nullable() }).strict();
export const captureIntentPath = (store: Store, id: string) => join(store.root, 'capture-intents', `${Id.parse(id)}.json`);
/** Evidence only: this grants neither approval nor authority and is never replayed. */
export function recordCaptureIntent(store: Store, id: string, source: Registration, destination: string, targetRoot: string, instruction?: string) {
  return store.lock(source.lineageId, () => {
    const directory = join(store.root, 'capture-intents');
    if (existsSync(directory)) for (const file of readdirSync(directory)) {
      const priorId = Id.parse(file.replace(/\.json$/, '')); const prior = captureObservation(store, priorId)!;
      if (prior.intent.source.lineageId === source.lineageId && prior.intent.source.generation === source.generation && prior.checkpoint !== 'complete') throw new CliError('CAPTURE_UNCERTAIN', 'An earlier capture intent for this source is unresolved; no new capture was issued.', 'uncertain', 'Observe this exact intent; never recapture or unfreeze to bypass uncertainty.', prior);
    }
    const intent = CaptureIntent.parse({ version: 1, transferId: id, source, destination, targetRoot: resolve(targetRoot), instructionDigest: instruction === undefined ? null : hash(instruction) });
    invariant(!existsSync(captureIntentPath(store, id)), 'Capture intent already exists; never recapture');
    privateDir(directory); syncDir(store.root);
    atomicWrite(captureIntentPath(store, id), json(intent)); return intent;
  });
}
export function captureObservation(store: Store, id: string) {
  if (!existsSync(captureIntentPath(store, id))) return null;
  let intent: z.infer<typeof CaptureIntent>;
  try { intent = readJson(captureIntentPath(store, id), CaptureIntent); invariant(intent.transferId === id, 'Capture intent ID changed'); }
  catch { throw new CliError('CORRUPT_STATE', 'Capture intent is invalid; retain the exact record.', 'target', null, { transferId: id }); }
  let checkpoint: 'complete' | 'missing' | 'partial-or-invalid' = 'missing';
  if (existsSync(store.transfer(id))) {
    checkpoint = 'partial-or-invalid';
    try {
      const { manifest, digest } = store.manifest(id); const status = store.status(id);
      invariant(manifest.native.sessionId === intent.source.sessionId && manifest.lineageId === intent.source.lineageId && manifest.generation === intent.source.generation + 1 && manifest.destination === intent.destination && manifest.target.repository === join(intent.targetRoot, 'runs', id, 'workspace', 'worktree') && (manifest.instruction === null ? null : hash(manifest.instruction)) === intent.instructionDigest && status.digest === digest, 'Capture intent/checkpoint binding changed');
      checkpoint = 'complete';
    } catch { /* Report partial/corrupt checkpoint explicitly, never infer capture failure. */ }
  }
  let owner = null; let registration = null; let bindings: 'recorded' | 'missing-or-invalid' = 'recorded';
  try { owner = store.owner(intent.source.lineageId); registration = store.registration(intent.source.sessionFile); }
  catch { bindings = 'missing-or-invalid'; }
  return { transferId: id, phase: 'unknown', observation: 'capture-intent' as const, intent, checkpoint, bindings, recordedOwner: owner, recordedRegistration: registration, task: 'not-tracked' };
}
