import { CliError } from './errors.js';
import { targetRepository } from './targets.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from './store.js';
import { Alias, Id, Receipt, type Config } from './schema.js';
import { configPath, loadConfig } from './config.js';
import { invariant } from './safe.js';
import { ssh, type Rpc } from './transport.js';
import { AttachTicket, attachmentBinding, authorizedAttachmentRoot, decodeTicket, encodeTicket, reopenGuidance, sameReceipt, verifyLocalAttachment } from './attachment.js';

const OpenTicket = z.object({ ticket: AttachTicket, alias: Alias.nullable() }).strict();
export type OpenTicket = z.infer<typeof OpenTicket>;
export type AttachRunner = (file: string, args: string[]) => Promise<void>;
export const runAttached: AttachRunner = (file, args) => new Promise((ok, fail) => {
  const child = spawn(file, args, { stdio: 'inherit' });
  child.on('error', fail); child.on('exit', (code, signal) => code === 0 ? ok() : fail(new Error(`Attachment exited ${code ?? signal}`)));
});
const runWindowRequest: AttachRunner = (file, args) => new Promise((ok, fail) => {
  // osascript may print a tab descriptor; it is not a public command result.
  const child = spawn(file, args, { stdio: 'ignore' });
  child.on('error', fail); child.on('exit', code => code === 0 ? ok() : fail(new Error('Terminal window request failed')));
});
interface OpenOptions {
  config?: Config; connect?: (alias: string) => Rpc; verify?: typeof verifyLocalAttachment;
  run?: AttachRunner; platform?: string; interactive?: boolean; configFile?: string;
}
export async function resolveAttachment(id: string, store: Store, options: OpenOptions = {}): Promise<OpenTicket> {
  Id.parse(id);
  const { manifest, digest, status, owner, receipt } = attachmentBinding(store, id);
  if (owner.state === 'owned' && status.ownership === 'destination') {
    await (options.verify ?? verifyLocalAttachment)(store, id, receipt);
    return { ticket: { id, digest, root: resolve(store.root), receipt }, alias: null };
  }
  invariant((owner.state === 'fenced' || owner.state === 'dispatched') && status.ownership === 'fenced', `No exact local owner or outbound fence for attachment; ${reopenGuidance}`);
  const config = options.config ?? loadConfig(); const alias = Alias.parse(manifest.destination); const host = config.hosts[alias];
  invariant(host, `Unconfigured destination ${alias}; use the destination's own bauble open ${id} --here or configure this SSH alias`);
  invariant(manifest.target.repository === targetRepository(manifest, host.root, host.codeRoot), 'Configured remote storage no longer matches this transfer');
  const remote = Receipt.parse(await (options.connect ?? ssh)(alias)({ operation: 'attach', root: host.root, data: { id, digest } }));
  sameReceipt(remote, receipt);
  // A concurrent return/fence change while the helper ran must not become a new route.
  const current = attachmentBinding(store, id);
  invariant((current.owner.state === 'fenced' || current.owner.state === 'dispatched') && current.status.ownership === 'fenced', 'Ownership changed during remote attachment');
  sameReceipt(current.receipt, receipt);
  return { ticket: { id, digest, root: resolve(store.root), receipt }, alias };
}
export function attachmentStore(id: string, config: Config, selected = new Store(), stateOverride = process.env.BAUBLE_STATE !== undefined) {
  Id.parse(id);
  // The remote helper stores at remoteRoot, which need not equal this host's localRoot.
  // Explicit BAUBLE_STATE is authoritative; otherwise an exact manifest may select remoteRoot.
  if (existsSync(join(selected.transfer(id), 'manifest.json')) || stateOverride || resolve(selected.root) === resolve(config.remoteRoot)) return selected;
  const path = join(resolve(config.remoteRoot), 'transfers', id, 'manifest.json');
  return existsSync(path) ? new Store(resolve(config.remoteRoot), selected.readOnly) : selected;
}
export function shellQuote(value: string) {
  invariant(!value.includes('\0'), 'NUL is not valid in terminal argv');
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export const terminalScript = 'on run argv\n tell application "Terminal"\n  activate\n  do script (item 1 of argv)\n end tell\nend run';
export function terminalCommand(value: OpenTicket, configuration: string, node = process.execPath, cli = fileURLToPath(new URL('./cli.js', import.meta.url))) {
  // AppleScript is fixed text; all shell values (including environment paths) are single-quoted argv.
  // Pin the selected root even when BAUBLE_STATE was originally unset or relative.
  return ['exec', '/usr/bin/env', `BAUBLE_CONFIG=${resolve(configuration)}`, `BAUBLE_STATE=${resolve(value.ticket.root)}`, resolve(node), resolve(cli), '_open', encodeTicket(OpenTicket.parse(value))].map(shellQuote).join(' ');
}
export async function attachResolved(value: OpenTicket, store: Store, options: OpenOptions = {}) {
  const current = await resolveAttachment(value.ticket.id, store, options);
  invariant(current.alias === value.alias && current.ticket.root === value.ticket.root && current.ticket.digest === value.ticket.digest, 'Attachment route changed');
  sameReceipt(current.ticket.receipt, value.ticket.receipt);
  const run = options.run ?? runAttached;
  if (current.alias === null) {
    await run('tmux', ['-L', current.ticket.receipt.socket, 'attach-session', '-t', current.ticket.receipt.target]);
  } else {
    const config = options.config ?? loadConfig();
    const remote = AttachTicket.parse({ ...current.ticket, root: config.hosts[current.alias]!.root });
    // Only a schema-bounded base64url token crosses the SSH shell. The destination revalidates it.
    await run('ssh', ['-t', '--', current.alias, `bauble _attach ${encodeTicket(remote)}`]);
  }
}
export async function openSession(id: string, here = false, store = new Store(), options: OpenOptions = {}) {
  Id.parse(id);
  if (here && !(options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) throw new CliError('CAPABILITY', 'open --here requires an interactive terminal; run it in a terminal (SSH users: allocate a TTY with ssh -t)', 'capability');
  if (!here && (options.platform ?? process.platform) !== 'darwin') throw new CliError('CAPABILITY', 'Opening a new terminal window is supported only on macOS with Terminal.app; on Linux/headless hosts run bauble open <transfer-id> --here in an interactive terminal', 'capability');
  const value = await resolveAttachment(id, store, options);
  if (here) await attachResolved(value, store, options);
  else {
    try { await (options.run ?? runWindowRequest)('/usr/bin/osascript', ['-e', terminalScript, '--', terminalCommand(value, options.configFile ?? configPath())]); }
    catch (error) { throw new CliError('CAPABILITY', `Could not open Terminal.app; allow Terminal automation or use bauble open ${id} --here in an interactive terminal.`, 'capability'); }
    return { windowRequested: true as const };
  }
}
export async function terminalOpen(encoded: string) {
  invariant(process.stdin.isTTY && process.stdout.isTTY, 'Terminal attachment requires an interactive terminal');
  const value = OpenTicket.parse(decodeTicket(encoded));
  invariant(resolve(new Store().root) === value.ticket.root, 'Terminal state selection changed');
  await attachResolved(value, new Store(value.ticket.root));
}
export async function remoteAttach(encoded: string) {
  invariant(process.stdin.isTTY && process.stdout.isTTY, 'Remote attachment requires an interactive terminal');
  const ticket = AttachTicket.parse(decodeTicket(encoded)); const root = authorizedAttachmentRoot(ticket.root, loadConfig()); const store = new Store(root);
  invariant(store.manifest(ticket.id).digest === ticket.digest, 'Remote attachment digest changed');
  const receipt = await verifyLocalAttachment(store, ticket.id, ticket.receipt);
  await runAttached('tmux', ['-L', receipt.socket, 'attach-session', '-t', receipt.target]);
}
