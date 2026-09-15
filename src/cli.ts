#!/usr/bin/env node
import { parseCommand, helpText } from './registry.js';
import { VERSION, PI_VERSION } from './metadata.js';
import { envelope, failure, printEnvelope, progressReporter } from './output.js';
let command = process.argv[2] ?? 'help';
let asJson = process.argv.includes('--json');
let durable: object | null = null;
const controller = new AbortController();
let interrupted = false;
process.once('SIGINT', () => { interrupted = true; controller.abort(); if (command !== 'log') { interruption(); process.exit(130); } });
async function main() {
  const parsed = parseCommand(process.argv.slice(2)); command = parsed.command; asJson = Boolean(parsed.values.json);
  if (parsed.internal) {
    process.umask(0o077);
    if (command === '_helper') { const { Request, readMessage } = await import('./transport.js'); const { loadConfig } = await import('./config.js'); const { handleRequest } = await import('./helper.js'); const data = await handleRequest(Request.parse(await readMessage(process.stdin)), { config: loadConfig(), allowFixture: true }); process.stdout.write(JSON.stringify({ ok: true, data }) + '\n'); return; }
    if (command === '_runtime') { if (parsed.args.length !== 1 || typeof parsed.values.root !== 'string') throw new Error('Internal runtime requires ID and root'); const { resolve } = await import('node:path'); await (await import('./commands.js')).internalRuntime(parsed.args[0]!, resolve(parsed.values.root)); return; }
    if (parsed.args.length !== 1) throw new Error('Internal attachment requires one ticket');
    const open = await import('./open.js'); await (command === '_open' ? open.terminalOpen(parsed.args[0]!) : open.remoteAttach(parsed.args[0]!)); return;
  }
  if (parsed.help || command === 'help' || command === 'host') { printEnvelope(envelope('help', { help: helpText(parsed.help || command === 'host' ? command : parsed.args.join(' ') || undefined) }), asJson); return; }
  if (command === 'version') { printEnvelope(envelope(command, { version: VERSION, piVersion: PI_VERSION }), asJson); return; }
  if (command === 'docs') { const docs = await import('./docs.js'); printEnvelope(envelope(command, parsed.values.list ? { topics: docs.topics() } : docs.documentation(parsed.args.join(' ') || undefined)), asJson); return; }
  process.umask(0o077);
  if (command === 'log') { await (await import('./cli-log.js')).logCommand(parsed.args[0]!, Boolean(parsed.values.follow), asJson, controller.signal); if (interrupted) interruption(); return; }
  const result = await (await import('./execute.js')).execute(parsed, { interactive: !asJson && !!process.stdin.isTTY && !!process.stdout.isTTY, progress: progressReporter(Boolean(parsed.values.quiet)), onDurable: data => { durable = { ...durable, ...data }; if (!asJson) process.stderr.write('Durable recovery identifiers: ' + JSON.stringify(data) + '\n'); } });
  const value = envelope(command, result.data, result.nextActions); if (result.error) { value.ok = false; value.error = result.error; }
  printEnvelope(value, asJson); process.exitCode = result.exitCode ?? 0;
  if (interrupted) process.exitCode = 130;
}
function interruption() { const value = envelope(command, { ...durable, interrupted: true }); value.ok = false; value.error = { code: 'INTERRUPTED', message: 'Interrupted; retain durable IDs and reconcile, never replay.', hint: null }; printEnvelope(value, asJson); process.exitCode = 130; }
main().catch(error => { if (interrupted) { interruption(); return; } const { value, exitCode } = failure(command, error); if (durable) value.data = { ...durable, ...value.data }; printEnvelope(value, asJson); process.exitCode = exitCode; });
