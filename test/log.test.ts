import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOG_BYTES, readLog } from '../src/log.js';
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
