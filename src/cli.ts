#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { loadConfig } from './config.js';
import { attach, hostRuntime, internalRuntime, pull, recover, send, setup } from './commands.js';
import { handleRequest } from './protocol.js';
import { Request, readMessage, ssh } from './transport.js';
import { invariant, json } from './safe.js';
import { attachmentStore, openSession, remoteAttach, terminalOpen } from './open.js';
import { messageSession, messageStatus } from './message.js';
const usage = `Bauble 0.1.0 — native Pi 0.85.1\nCommands: setup <ssh-alias> [--default], pi [--session path-or-id],\n send --session path-or-id [--host alias] [--instruction-file path] [--approval-digest sha256],\n send --checkpoint path, ls [--json], log <id> [--follow], attach <id>, open <id> [--here],\n message <id> <text> [--request-id uuid], message-status <id> --request-id uuid,\n pull <id> [--approval-digest sha256], recover <id> [--cancel] [--approval-digest sha256]\nSensitive workspace/history inclusion: --include-sensitive path / --include-history path (repeatable).\nNo --yes; no newest-session selection; setup never installs software.`;
async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { help: { type: 'boolean' }, default: { type: 'boolean' }, session: { type: 'string' }, host: { type: 'string' }, checkpoint: { type: 'string' }, 'instruction-file': { type: 'string' }, 'approval-digest': { type: 'string' }, 'include-sensitive': { type: 'string', multiple: true }, 'include-history': { type: 'string', multiple: true }, json: { type: 'boolean' }, follow: { type: 'boolean' }, 'request-id': { type: 'string' }, here: { type: 'boolean' }, cancel: { type: 'boolean' }, root: { type: 'string' } } });
  const [command, argument, ...extra] = positionals;
  if (values.help || !command) { console.log(usage); return; }
  invariant(extra.length === (command === 'message' ? 1 : 0), command === 'message' ? 'message requires one literal text argument (quote it; use -- before text beginning with -)' : 'Unexpected positional arguments');
  invariant(!values.here || command === 'open', '--here is supported only by open');
  invariant(!values['request-id'] || command === 'message' || command === 'message-status', '--request-id is supported only by message/message-status');
  if (command === '_open') { invariant(argument, 'Internal open requires ticket'); await terminalOpen(argument); return; }
  if (command === '_attach') { invariant(argument, 'Internal attach requires ticket'); await remoteAttach(argument); return; }
  if (command === '_helper') { const request = Request.parse(await readMessage(process.stdin)); const data = await handleRequest(request, { config: loadConfig(), allowFixture: true }); process.stdout.write(json({ ok: true, data })); return; }
  if (command === '_runtime') { invariant(argument && values.root, 'Internal runtime requires ID and root'); await internalRuntime(argument, resolve(values.root)); return; }
  if (command === 'setup') { invariant(argument, 'setup requires configured SSH alias'); await setup(argument, values.default ?? false); return; }
  const store = new Store();
  if (command === 'pi') { const config = loadConfig(); let profilePath = config.profile; if (values.session) { try { profilePath = store.registration(values.session).profilePath; } catch { /* Explicit bare path adoption handled by controlled launcher. */ } } await hostRuntime({ store, profilePath, cwd: process.cwd(), session: values.session, allowTest: process.env.BAUBLE_TEST_MODE === '1' }); return; }
  if (command === 'send') { await send({ session: values.session, checkpoint: values.checkpoint, host: values.host, instructionFile: values['instruction-file'], approvalDigest: values['approval-digest'], sensitive: values['include-sensitive'], history: values['include-history'] }, store); return; }
  if (command === 'ls') { const rows = store.list(); console.log(values.json ? json(rows) : rows.map(r => `${r.transferId} ${r.manifest.destination} phase=${r.phase} owner=${r.ownership} execution=${r.execution} observed=${r.updated}`).join('\n')); return; }
  invariant(argument, `${command} requires a transfer ID`);
  if (command === 'message' || command === 'message-status') {
    const selected = attachmentStore(argument, loadConfig(), store);
    if (command === 'message-status') invariant(values['request-id'], 'message-status requires explicit --request-id uuid');
    const value = command === 'message' ? await messageSession(argument, extra[0]!, values['request-id'], selected, { onIntent: requestId => console.error(`Message request ID: ${requestId} (durable intent; not acceptance)`) }) : await messageStatus(argument, values['request-id']!, selected);
    console.log(json(value));
    if (value.state !== 'accepted') {
      console.error(value.state === 'rejected' ? 'Positively rejected; wait until fully idle, fix preflight if needed, then explicitly retry with a NEW request ID.' : `Delivery ${value.state}; use message-status with this request ID. Never automatically resend or use a new ID to bypass uncertainty.`);
      process.exitCode = 1;
    }
  }
  else if (command === 'open') await openSession(argument, values.here ?? false, attachmentStore(argument, loadConfig(), store));
  else if (command === 'attach') await attach(argument, attachmentStore(argument, loadConfig(), store));
  else if (command === 'pull') await pull(argument, values['approval-digest'], store);
  else if (command === 'recover') await recover(argument, values.cancel ?? false, store, { approvalDigest: values['approval-digest'] });
  else if (command === 'log') {
    const { manifest, digest } = store.manifest(argument); const config = loadConfig(); const host = config.hosts[manifest.destination]; invariant(host, 'Destination not configured');
    let last = ''; do { const value = await ssh(manifest.destination)({ operation: 'log', root: host.root, data: { id: argument, digest } }) as { text: string }; if (value.text !== last) { process.stdout.write(value.text.startsWith(last) ? value.text.slice(last.length) : value.text); last = value.text; } if (values.follow) await new Promise(ok => setTimeout(ok, 1000)); } while (values.follow);
  } else throw new Error(`Unknown command: ${command}\n${usage}`);
}
main().catch(error => { console.error(`bauble: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
