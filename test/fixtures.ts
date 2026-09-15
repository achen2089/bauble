import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Profile } from '../src/schema.js';
import { atomicWrite, json, run } from '../src/safe.js';
export function fixtureRoot() { return mkdtempSync(join(tmpdir(), 'bauble-test-')); }
export function fixtureProfile(root: string) {
  const profile = Profile.parse({ version: 1, policy: 'bauble-pi-v1', provider: 'bauble-fixture', model: 'deterministic', thinking: 'off', tools: ['read', 'write', 'edit', 'bash'], instructions: [], skills: [], prompts: [], settings: { compaction: { enabled: false } }, testOnly: true });
  const path = join(root, 'profile.json'); atomicWrite(path, json(profile)); return { profile, path };
}
export function fixtureRepo(root: string) {
  const repo = join(root, 'original'); mkdirSync(repo);
  run('git', ['init', '--template=', repo]);
  run('git', ['config', 'user.name', 'Bauble Fixture'], { cwd: repo }); run('git', ['config', 'user.email', 'fixture@invalid'], { cwd: repo });
  writeFileSync(join(repo, '.gitignore'), '.env\nignored/\n'); writeFileSync(join(repo, 'staged.txt'), 'base\n'); writeFileSync(join(repo, 'deleted.txt'), 'delete\n'); writeFileSync(join(repo, 'exec.sh'), '#!/bin/sh\nexit 0\n');
  run('git', ['add', '.'], { cwd: repo }); run('git', ['commit', '-m', 'fixture history'], { cwd: repo });
  writeFileSync(join(repo, 'staged.txt'), 'staged only\n'); writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 255, 42, 10])); run('git', ['add', 'staged.txt', 'binary.bin'], { cwd: repo });
  writeFileSync(join(repo, 'staged.txt'), 'unstaged\n'); writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 254, 42, 10])); unlinkSync(join(repo, 'deleted.txt')); chmodSync(join(repo, 'exec.sh'), 0o755); symlinkSync('staged.txt', join(repo, 'safe-link')); writeFileSync(join(repo, 'untracked.txt'), 'approved untracked\n'); writeFileSync(join(repo, '.env'), 'SECRET=never-transfer\n');
  return repo;
}
export function assistant(text: string): AssistantMessage { return { role: 'assistant', content: [{ type: 'text', text }], api: 'bauble-fixture', provider: 'bauble-fixture', model: 'deterministic', usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() }; }
export function fixtureSession(cwd: string, root: string) {
  const manager = SessionManager.create(cwd, join(root, 'sessions'));
  const user = manager.appendMessage({ role: 'user', content: 'first request', timestamp: Date.now() });
  manager.appendMessage(assistant('first response')); manager.appendModelChange('bauble-fixture', 'older-model'); manager.appendThinkingLevelChange('high'); manager.appendModelChange('bauble-fixture', 'deterministic'); manager.appendThinkingLevelChange('off');
  manager.appendLabelChange(user, 'first-label'); manager.appendCustomEntry('fixture:state', { count: 7 });
  const call = assistant(''); call.content = [{ type: 'toolCall', id: 'history-tool', name: 'read', arguments: { path: 'staged.txt' } }]; call.stopReason = 'toolUse'; manager.appendMessage(call);
  const artifact = join(root, 'full-output.txt'); writeFileSync(artifact, 'Full historical artifact bytes.\n');
  manager.appendMessage({ role: 'toolResult', toolCallId: 'history-tool', toolName: 'read', content: [{ type: 'text', text: 'base\n' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }], details: { fullOutputPath: artifact }, isError: false, timestamp: Date.now() });
  const retained = manager.appendMessage({ role: 'user', content: 'retained request', timestamp: Date.now() }); manager.appendMessage(assistant('retained reply'));
  manager.appendCompaction('Native persisted compaction summary', retained, 1000);
  const leaf = manager.appendMessage(assistant('active response'));
  manager.branch(user); manager.appendMessage({ role: 'user', content: 'alternate physical last branch', timestamp: Date.now() }); manager.appendMessage(assistant('alternate response'));
  manager.branch(leaf); return { manager, leaf, artifact };
}
