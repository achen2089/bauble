import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { resolveTransfer } from './queries.js';
import { targetRepository } from './targets.js';
import { invariant } from './safe.js';
import { LogChunk, readLog, type LogCursor } from './log.js';
import { ssh, type Rpc } from './transport.js';
import { envelope, printEnvelope } from './output.js';
export async function logCommand(input: string, follow: boolean, asJson: boolean, signal: AbortSignal, connect: (alias: string) => Rpc = ssh) {
  const { store, id } = resolveTransfer(input); const { manifest, digest } = store.manifest(id);
  const localAuthorized = () => {
    if (!existsSync(store.ownerPath(manifest.lineageId))) return false;
    const owner = store.owner(manifest.lineageId);
    return owner.state === 'owned' && owner.transferId === id && owner.digest === digest && owner.generation === manifest.generation && store.status(id).ownership === 'destination';
  };
  const local = localAuthorized();
  if (local) invariant(manifest.target.repository === targetRepository(manifest, store.root, manifest.codeRoot ? loadConfig().codeRoot : undefined), 'Local log destination configuration changed');
  const config = local ? undefined : loadConfig(); const host = config?.hosts[manifest.destination];
  if (!local) { invariant(host, 'Destination not configured'); invariant(manifest.target.repository === targetRepository(manifest, host.root, host.codeRoot), 'Log destination configuration changed'); }
  const rpc = local ? undefined : connect(manifest.destination); let cursor: LogCursor | undefined; let sequence = 0;
  do {
    if (local) invariant(localAuthorized() && store.manifest(id).digest === digest, 'Local log ownership changed');
    const chunk = local ? readLog(join(store.transfer(id), 'run.log'), cursor) : LogChunk.parse(await rpc!({ operation: 'log', root: host!.root, data: { id, digest, ...(cursor ? { cursor } : {}) } }));
    if (asJson) printEnvelope(envelope('log', { transferId: id, sequence: sequence++, ...chunk }), true); else if (chunk.text) process.stdout.write(chunk.text);
    cursor = chunk.cursor ?? undefined;
    if (follow && chunk.caughtUp && !signal.aborted) await new Promise<void>(ok => { const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); ok(); }; const timer = setTimeout(finish, 1000); signal.addEventListener('abort', finish, { once: true }); });
  } while (follow && !signal.aborted);
}
