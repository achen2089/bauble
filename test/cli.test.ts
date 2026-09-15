import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const cli = resolve('dist/src/cli.js');
function invoke(args: string[]) { const home = mkdtempSync(join(tmpdir(), 'bauble-cli-')); try { const result = spawnSync(process.execPath, [cli, ...args], { cwd: home, env: { ...process.env, HOME: home, BAUBLE_CONFIG: join(home, 'config.json'), BAUBLE_STATE: join(home, 'state') }, encoding: 'utf8' }); assert.equal(existsSync(join(home, 'state')), false, 'early/read-only commands must not create state'); return result; } finally { rmSync(home, { recursive: true, force: true }); } }
test('CLI discovery is config-free with stable envelopes and strict early rejection', () => {
  for (const args of [[], ['--help'], ['-h'], ['--version'], ['-V'], ['help', 'host', 'add'], ['docs', 'automation'], ['docs', '--list']]) { const result = invoke([...args, '--json']); assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout); assert.equal(value.schemaVersion, 1); assert.equal(value.ok, true); }
  for (const args of [['typo'], ['ls', '--host', 'elsewhere'], ['run', '--prompt', 'x', '--prepare', '--auto-approve'], ['send', '--checkpoint', '/tmp/no', '--prepare'], ['attach', 'id', '--json'], ['open', 'id', '--here', '--json'], ['pi', '--json'], ['host', 'list', '--default'], ['status'], ['message', 'id', 'a', 'b']]) { const result = invoke([...args, '--json']); assert.equal(result.status, 2, result.stderr); assert.equal(JSON.parse(result.stdout).error.code, 'USAGE'); }
  const empty = invoke(['sessions', '--json']); assert.equal(empty.status, 0, empty.stderr); assert.deepEqual(JSON.parse(empty.stdout).data.sessions, []);
});

import { commands, parseCommand } from '../src/registry.js';
import { writeFileSync, chmodSync, statSync, mkdirSync } from 'node:fs';
import { failure } from '../src/output.js';
import { CliError } from '../src/errors.js';
test('every public command has help, JSON help, examples and command-specific early flag validation', () => {
  for (const command of commands) {
    const result = invoke([...command.name.split(' '), '--help', '--json']); assert.equal(result.status, 0, result.stderr); const help = JSON.parse(result.stdout); assert.equal(help.schemaVersion, 1); assert.equal(help.command, 'help'); assert.ok(help.data.help.includes(command.name));
    assert.throws(() => parseCommand([...command.name.split(' '), '--not-a-flag']), { code: 'USAGE' });
  }
});
test('error envelope categories never expose arbitrary failure text', () => {
  for (const [category, exitCode] of [['usage', 2], ['config', 1], ['capability', 1], ['target', 1], ['approval', 3], ['busy', 1], ['uncertain', 4]] as const) assert.equal(failure('test', new CliError('TEST', 'safe', category)).exitCode, exitCode);
  assert.ok(!JSON.stringify(failure('test', new Error('secret provider prompt AUTH_TOKEN'))).includes('AUTH_TOKEN'));
});
test('metadata and cheap import graphs work when Pi/native/checkpoint imports are unavailable', () => {
  const home = mkdtempSync(join(tmpdir(), 'bauble-import-')); const loader = join(home, 'deny.mjs');
  writeFileSync(loader, `export async function resolve(specifier, context, next) { if (specifier.startsWith('@earendil-works/') || /\\/(?:runtime|native|checkpoint|fresh|terminal)\\.js$/.test(specifier)) throw new Error('heavy import forbidden: '+specifier); return next(specifier, context); }`);
  const env = { ...process.env, HOME: home, BAUBLE_CONFIG: join(home, 'missing.json'), BAUBLE_STATE: join(home, 'state') };
  try {
    for (const args of [['--help'], ['docs'], ['--version'], ['sessions', '--json'], ['ls', '--json']]) { const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, cli, ...args], { env, cwd: home, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); }
    for (const module of ['helper', 'message', 'attachment', 'open', 'hosts', 'queries']) { const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', `await import(${JSON.stringify('file://' + resolve('dist/src/' + module + '.js'))})`], { env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); }
    assert.equal(existsSync(join(home, 'state')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('read-only queries report corrupt registrations without changing directories or modes', () => {
  const home = mkdtempSync(join(tmpdir(), 'bauble-readonly-')); const state = join(home, 'state');
  mkdirSync(join(state, 'sessions'), { recursive: true }); chmodSync(state, 0o750); writeFileSync(join(state, 'sessions', 'broken.json'), '{broken secret payload');
  const before = statSync(state).mode;
  try {
    const result = spawnSync(process.execPath, [cli, 'sessions', '--json'], { env: { ...process.env, BAUBLE_CONFIG: join(home, 'missing'), BAUBLE_STATE: state }, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'CORRUPT_STATE'); assert.ok(!result.stdout.includes('secret payload')); assert.equal(statSync(state).mode, before); assert.equal(existsSync(join(state, 'blobs')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
