import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable, Writable } from 'node:stream';
import { frames, MAX_FRAME, rpcScope, serveStream, streamHello, streamRpc, writeFrame } from '../src/stream.js';
import type { Request } from '../src/transport.js';
const script = resolve('dist/test/stream-process.js');
const request: Request = { operation: 'status', root: '/test', data: { value: 'α🙂' } };

test('stream framing: fragmented/coalesced, strict UTF8, malformed, truncated and bounded', async () => {
  const encoded = Buffer.from('{"text":"🙂"}\n{}\n');
  const values = []; for await (const v of frames(Readable.from([...encoded].map(byte => Buffer.from([byte]))))) values.push(v);
  assert.deepEqual(values, [{ text: '🙂' }, {}]);
  for (const bytes of [Buffer.from([0xc0, 0xaf, 10]), Buffer.from('{}'), Buffer.from('bad\n'), Buffer.from('x'.repeat(MAX_FRAME + 1)), Buffer.from('\n')]) {
    await assert.rejects(async () => { for await (const _v of frames(Readable.from([bytes]))) { /* validate */ } });
  }
  assert.throws(() => writeFrame(new PassThrough(), { text: 'x'.repeat(MAX_FRAME) }), /2 MiB/);
});

test('stream server: handshake before admission, sequential IDs and response backpressure', async () => {
  const input = new PassThrough(); let writes = 0; let handling = 0; let maximum = 0; const calls: number[] = [];
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, cb) { writes++; setTimeout(cb, 20); } });
  const serving = serveStream(input, output, async () => { handling++; maximum = Math.max(maximum, handling); calls.push(writes); await new Promise(ok => setTimeout(ok, 5)); handling--; return {}; });
  input.end([streamHello(), { type: 'request', id: 1, request }, { type: 'request', id: 2, request }].map(v => JSON.stringify(v)).join('\n') + '\n');
  await serving; assert.equal(maximum, 1); assert.deepEqual(calls, [1, 2]); assert.equal(writes, 3);
  for (const values of [[{ type: 'request', id: 1, request }], [streamHello(), { type: 'request', id: 2, request }], [streamHello(), { type: 'request', id: 1, request }, { type: 'request', id: 1, request }]]) {
    let admitted = 0; await assert.rejects(serveStream(Readable.from([values.map(v => JSON.stringify(v)).join('\n') + '\n']), new Writable({ write(_c, _e, cb) { cb(); } }), async () => { admitted++; return {}; }));
    assert.equal(admitted, values.length === 3 ? 1 : 0);
  }
});

test('stream RPC subprocess: one helper, correlation, bounded failure and no reconnect/replay', async () => {
  for (const mode of ['echo', 'incompatible', 'no-handshake', 'wrong-id', 'duplicate', 'malformed', 'utf8', 'oversized', 'timeout', 'lost-ack']) {
    let starts = 0; let closed: Promise<unknown> = Promise.resolve();
    const rpc = streamRpc(() => { starts++; const child = spawn(process.execPath, [script, mode], { stdio: ['pipe', 'pipe', 'pipe'] }); closed = once(child, 'close'); return child; }, 1000);
    const scope = rpcScope(() => rpc); assert.equal(scope.connect('host'), scope.connect('host'));
    try {
      if (mode === 'echo') {
        for (let i = 0; i < 10; i++) assert.deepEqual(await rpc(request), request.data);
        await assert.rejects(rpc({ ...request, operation: 'revoke' }), error => error instanceof Error && !error.message.includes('SECRET'));
        assert.deepEqual(await rpc(request), request.data);
      } else {
        if (mode === 'duplicate') { await rpc(request); await new Promise(ok => setTimeout(ok, 50)); }
        else await assert.rejects(rpc(request));
        await assert.rejects(rpc(request));
      }
      assert.equal(starts, 1);
    } finally { scope.close(); assert.throws(() => scope.connect('host'), /closed/); await closed; }
  }
});

test('server response loss does not cancel admitted work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bauble-stream-admit-')); const marker = join(root, 'admission');
  const child = spawn(process.execPath, [script, 'lost-response', marker], { stdio: ['pipe', 'pipe', 'pipe'] }); child.stderr.resume();
  try {
    await writeFrame(child.stdin, streamHello()); await once(child.stdout, 'data');
    await writeFrame(child.stdin, { type: 'request', id: 1, request });
    const deadline = Date.now() + 3000; while (!existsSync(marker) && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 10));
    assert.equal(readFileSync(marker, 'utf8'), 'admitted');
    child.stdout.destroy(); child.stdin.end(); await once(child, 'close');
    assert.equal(readFileSync(marker, 'utf8'), 'admitted:finished');
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('_helper-stream reloads configured root for every request before storage access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bauble-stream-config-')); const configPath = join(root, 'config.json'); const remote = join(root, 'remote');
  const config = { version: 1, hosts: {}, profile: join(root, 'no-profile'), localRoot: join(root, 'local'), remoteRoot: remote };
  writeFileSync(configPath, JSON.stringify(config));
  const rpc = streamRpc(() => spawn(process.execPath, [resolve('dist/src/cli.js'), '_helper-stream'], { env: { ...process.env, BAUBLE_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] }));
  try {
    // A missing log checkpoint fails without creating storage; a changed root must also reject.
    await assert.rejects(rpc({ operation: 'log', root: remote, data: { id: '00000000-0000-4000-8000-000000000000', digest: 'a'.repeat(64) } }));
    writeFileSync(configPath, JSON.stringify({ ...config, remoteRoot: join(root, 'changed') }));
    await assert.rejects(rpc({ operation: 'manifest', root: remote, data: {} }));
    assert.equal(existsSync(remote), false, 'root validation must precede mutable Store construction');
  } finally { rpc.close(); rmSync(root, { recursive: true, force: true }); }
});
