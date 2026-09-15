import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { fixtureRoot, fixtureRepo } from './fixtures.js';
import { Store } from '../src/store.js';
import { captureWorkspace, restoreWorkspace } from '../src/workspace.js';
import { run, safePath, validatePaths, safeLink } from '../src/safe.js';
test('workspace rejects traversal, symlink escapes/chains, collisions and special index state', () => {
  for (const path of ['../escape', '/root', '.git/config', 'dir/.GIT/config', 'a\\b', 'a\n']) assert.throws(() => safePath(path));
  assert.throws(() => validatePaths(['File', 'file'])); assert.throws(() => validatePaths(['a', 'a/b'])); assert.throws(() => safeLink('a', '../../outside'));
  const root = fixtureRoot(); const repo = fixtureRepo(root); const store = new Store(join(root, 'state'));
  symlinkSync('/etc/passwd', join(repo, 'escape')); assert.throws(() => captureWorkspace(repo, store.blobs), /symlink/); unlinkSync(join(repo, 'escape'));
  run('git', ['update-index', '--assume-unchanged', 'staged.txt'], { cwd: repo }); assert.throws(() => captureWorkspace(repo, store.blobs), /assume-unchanged/); rmSync(root, { recursive: true, force: true });
});
test('history secrets cannot be labelled excluded; explicit ordinary file/history approval and forbidden credentials', () => {
  const root = fixtureRoot(); const repo = fixtureRepo(root); const store = new Store(join(root, 'state'));
  run('git', ['add', '-f', '.env'], { cwd: repo }); run('git', ['commit', '-m', 'historical secret fixture'], { cwd: repo }); run('git', ['rm', '--cached', '.env'], { cwd: repo });
  assert.throws(() => captureWorkspace(repo, store.blobs), /historical bytes/);
  const captured = captureWorkspace(repo, store.blobs, [], ['.env']); assert.deepEqual(captured.workspace.historySensitive, ['.env']); assert.ok(captured.workspace.excluded.some(e => e.path === '.env'));
  writeFileSync(join(repo, 'auth.json'), '{"key":"not-real"}'); assert.throws(() => captureWorkspace(repo, store.blobs, ['auth.json'], ['.env']), /credential/);
  rmSync(root, { recursive: true, force: true });
});
