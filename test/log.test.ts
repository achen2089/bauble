import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync, symlinkSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOG_BYTES, readLog, appendLog } from '../src/log.js';
test('log byte cursors: bounded tail, UTF-8 boundaries, no prefix replay, replacement/truncation reset', () => {
  const root = mkdtempSync(join(tmpdir(), 'bauble-log-')); const path = join(root, 'run.log');
  try {
    writeFileSync(path, '🙂'.repeat(LOG_BYTES)); const first = readLog(path); assert.ok(Buffer.byteLength(first.text) <= LOG_BYTES); assert.ok(!first.text.includes('�')); assert.equal(first.caughtUp, true);
    assert.equal(readLog(path, first.cursor!).text, ''); appendFileSync(path, 'αβ'); const next = readLog(path, first.cursor!); assert.equal(next.text, 'αβ'); assert.equal(next.reset, false);
    appendFileSync(path, Buffer.from([0xf0, 0x9f])); const partial = readLog(path, next.cursor!); assert.equal(partial.text, ''); appendFileSync(path, Buffer.from([0x99, 0x82])); const complete = readLog(path, partial.cursor!); assert.equal(complete.text, '🙂');
    writeFileSync(path, 'short'); const truncated = readLog(path, complete.cursor!); assert.equal(truncated.reset, true); assert.equal(truncated.text, 'short');
    renameSync(path, path + '.old'); writeFileSync(path, 'replacement'); const replacement = readLog(path, truncated.cursor!); assert.equal(replacement.reset, true); assert.equal(replacement.text, 'replacement');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('log append: private creation, stable identity, rejects symlink and nonregular targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'bauble-log-append-')); const path = join(root, 'run.log');
  try {
    appendLog(path, 'first α\n'); assert.equal(statSync(path).mode & 0o777, 0o600); const first = readLog(path);
    appendLog(path, 'second 🙂\n'); const second = readLog(path, first.cursor!); assert.equal(second.text, 'second 🙂\n'); assert.equal(second.reset, false); assert.equal(second.cursor!.identity, first.cursor!.identity);
    const link = join(root, 'link'); symlinkSync(path, link); assert.throws(() => appendLog(link, 'must not write')); assert.throws(() => readLog(link));
    const directory = join(root, 'directory'); mkdirSync(directory); assert.throws(() => appendLog(directory, 'must not write')); assert.equal(readFileSync(path, 'utf8'), 'first α\nsecond 🙂\n');
    const fifo = join(root, 'fifo'); assert.equal(spawnSync('mkfifo', [fifo]).status, 0); assert.throws(() => appendLog(fifo, 'must not block')); assert.throws(() => readLog(fifo), /regular file/);
    writeFileSync(path, Buffer.from([0xff])); assert.throws(() => readLog(path), /UTF-8/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('log append handles short writes and synchronizes first-created directory before return', t => {
  const root = mkdtempSync(join(tmpdir(), 'bauble-log-short-')); const path = join(root, 'run.log'); const write = fs.writeSync; const synced: number[] = []; const fsync = fs.fsyncSync;
  try {
    t.mock.method(fs, 'writeSync', (fd: number, bytes: Buffer, offset: number, length: number) => write(fd, bytes, offset, Math.min(length, 2)));
    t.mock.method(fs, 'fsyncSync', (fd: number) => { synced.push(fd); fsync(fd); }); syncBuiltinESMExports();
    appendLog(path, 'short writes α🙂\n'); assert.equal(readFileSync(path, 'utf8'), 'short writes α🙂\n'); assert.equal(synced.length, 2);
    synced.length = 0; appendLog(path, 'tail'); assert.equal(synced.length, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
