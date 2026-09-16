import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fixtureRoot, fixtureProfile } from './fixtures.js';
import { Store } from '../src/store.js';
import { captureTask } from '../src/run.js';
import { stage } from '../src/protocol.js';
import { CHUNK, type Rpc } from '../src/transport.js';
import { rpcScope, streamRpc } from '../src/stream.js';
import { snapshotProfile } from '../src/pi/profile.js';
import { LogChunk, type LogCursor } from '../src/log.js';

test('remote transfer benchmark: 100 small blobs + multi-chunk file, one helper including cursor polls; one-shot retained', { timeout: 60000 }, async () => {
  const root = realpathSync(fixtureRoot()); const profile = fixtureProfile(root); const cwd = join(root, 'workspace'); mkdirSync(cwd);
  for (let i = 0; i < 100; i++) writeFileSync(join(cwd, `small-${i}.txt`), `controlled small blob ${i}\n`);
  writeFileSync(join(cwd, 'multi-chunk.bin'), Buffer.alloc(CHUNK * 2 + 17, 42));
  const source = new Store(join(root, 'source')); const profileDigest = snapshotProfile(profile.profile, root, source.blobs).digest;
  const configured = join(root, 'destination'); const configFile = join(root, 'config.json'); const config = { version: 1, hosts: {}, profile: profile.path, localRoot: source.root, remoteRoot: configured };
  writeFileSync(configFile, JSON.stringify(config)); const env = { ...process.env, BAUBLE_CONFIG: configFile, BAUBLE_TEST_MODE: '1' }; const cli = resolve('dist/src/cli.js');
  const beforeMode = process.env.BAUBLE_TEST_MODE; process.env.BAUBLE_TEST_MODE = '1';
  const measurements: object[] = [];
  try {
    for (const mode of ['stream', 'one-shot']) {
      const remoteRoot = join(configured, 'fixtures', randomUUID());
      const captured = await captureTask({ cwd, prompt: 'controlled fixture; never dispatched' }, source, { alias: 'fixture', root: remoteRoot, profile: profile.path, profileDigest });
      const id = captured.manifest.transferId; source.approve(id, captured.digest); let helpers = 0; let calls = 0;
      const start = (command: string) => { helpers++; return spawn(process.execPath, [cli, command], { env, stdio: ['pipe', 'pipe', 'pipe'] }); };
      const persistent = streamRpc(() => start('_helper-stream'));
      const oneShot: Rpc = request => new Promise((ok, fail) => {
        const child = start('_helper'); let output = ''; let stderr = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => stderr += b); child.on('error', fail);
        child.on('close', code => { try { assert.equal(code, 0, stderr); const value = JSON.parse(output); assert.equal(value.ok, true); ok(value.data); } catch (error) { fail(error); } }); child.stdin.end(JSON.stringify(request));
      });
      const scope = rpcScope(() => mode === 'stream' ? persistent : oneShot);
      const rpc: Rpc = request => { calls++; return scope.connect('fixture')(request); };
      const started = performance.now();
      try {
        await stage(source, id, rpc, remoteRoot); const transferMs = performance.now() - started;
        const remote = new Store(remoteRoot, true); remote.verify(id); assert.equal(remote.status(id).phase, 'ready'); assert.equal(captured.manifest.blobs.length, 101);
        assert.equal(calls, 105, 'manifest + 100 small + 3 large chunks + ready');
        const log = join(remote.transfer(id), 'run.log'); let cursor: LogCursor | undefined;
        const logStart = performance.now();
        for (let i = 0; i < 5; i++) {
          appendFileSync(log, `poll ${i} α🙂\n`);
          const chunk = LogChunk.parse(await rpc({ operation: 'log', root: remoteRoot, data: { id, digest: captured.digest, ...(cursor ? { cursor } : {}) } }));
          assert.equal(chunk.text, `poll ${i} α🙂\n`); assert.equal(chunk.reset, false); cursor = chunk.cursor!;
        }
        assert.equal(helpers, mode === 'stream' ? 1 : 110);
        measurements.push({ mode, smallBlobs: 100, multiChunkBytes: CHUNK * 2 + 17, transferRpcCount: 105, logPolls: 5, totalRpcCount: calls, helpers, transferMs: Math.round(transferMs), cursorPollMs: Math.round(performance.now() - logStart) });
      } finally { scope.close(); persistent.close(); }
    }
    console.log('REMOTE_BENCHMARK ' + JSON.stringify(measurements));
  } finally { if (beforeMode === undefined) delete process.env.BAUBLE_TEST_MODE; else process.env.BAUBLE_TEST_MODE = beforeMode; rmSync(root, { recursive: true, force: true }); }
});
