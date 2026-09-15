import { SessionManager, buildSessionContext, type AgentSession, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Blobs } from '../blobs.js';
import { Native, type Profile, type Registration } from '../schema.js';
import { atomicWrite, hash, invariant, json, privateDir, readBytes } from '../safe.js';
import { forbidden } from '../workspace.js';
import { snapshotProfile } from './profile.js';

export type { AgentSession } from '@earendil-works/pi-coding-agent';
const content = z.union([z.string(), z.array(z.object({ type: z.enum(['text', 'image', 'thinking', 'toolCall']) }).passthrough())]);
const message = z.object({ role: z.enum(['user', 'assistant', 'toolResult', 'bashExecution', 'custom']), timestamp: z.number(), content: content.optional() }).passthrough();
const base = z.object({ id: z.string().min(1), parentId: z.string().nullable(), timestamp: z.iso.datetime(), type: z.enum(['message', 'model_change', 'thinking_level_change', 'compaction', 'branch_summary', 'custom', 'custom_message', 'label', 'session_info']) }).passthrough();
/** Validate before Pi's permissive loader can skip malformed lines or migrate source bytes. */
export function validateSession(bytes: Buffer, leaf: string, testOnly = false): { header: { id: string; cwd: string }; entries: SessionEntry[] } {
  const text = bytes.toString('utf8'); invariant(Buffer.from(text).equals(bytes) && text.endsWith('\n'), 'Session must be complete UTF-8 JSONL ending in newline');
  const lines = text.slice(0, -1).split('\n'); invariant(lines.length > 1 && lines.every(Boolean), 'Empty/incomplete native session');
  const raw: unknown[] = lines.map(line => JSON.parse(line));
  const header = z.object({ type: z.literal('session'), version: z.literal(3), id: z.string().min(1), cwd: z.string().min(1), timestamp: z.iso.datetime() }).passthrough().parse(raw[0]);
  const ids = new Set<string>(); const entries: SessionEntry[] = [];
  for (const item of raw.slice(1)) {
    const entry = base.parse(item); invariant(!ids.has(entry.id), `Duplicate native entry: ${entry.id}`);
    invariant(entry.parentId === null || ids.has(entry.parentId), `Broken parent: ${entry.id}`);
    if (entry.type === 'message') {
      const m = message.parse(entry.message);
      if (m.role !== 'bashExecution') content.parse(m.content);
      if (m.role === 'assistant') { invariant(['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(m.stopReason)), 'Unsettled/pending assistant entry'); z.string().parse(m.model); z.string().parse(m.provider); }
      if (m.role === 'toolResult') { z.string().parse(m.toolCallId); z.string().parse(m.toolName); z.boolean().parse(m.isError); }
    }
    if (entry.type === 'compaction') {
      invariant(!('retainedTail' in entry), 'Pi 0.85.1 native builder does not support retainedTail compactions despite its docs; checkpoint rejected without changing source');
      z.string().parse(entry.summary); z.number().nonnegative().parse(entry.tokensBefore);
      invariant(typeof entry.firstKeptEntryId === 'string' && ids.has(entry.firstKeptEntryId), 'Unsupported/incomplete compaction firstKeptEntryId');
    }
    if (entry.type === 'model_change') { z.string().parse(entry.provider); z.string().parse(entry.modelId); }
    if (entry.type === 'thinking_level_change') z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).parse(entry.thinkingLevel);
    if (entry.type === 'branch_summary') { z.string().parse(entry.summary); invariant(typeof entry.fromId === 'string' && ids.has(entry.fromId), 'Invalid branch summary reference'); }
    if (entry.type === 'label') invariant(typeof entry.targetId === 'string' && ids.has(entry.targetId), 'Invalid label reference');
    if (entry.type === 'custom' || entry.type === 'custom_message' || (entry.type === 'message' && (entry.message as { role: string }).role === 'custom')) {
      const customType = entry.customType ?? (entry.message as { customType?: string } | undefined)?.customType;
      invariant(typeof customType === 'string' && (customType.startsWith('bauble:') || (testOnly && customType === 'fixture:state')), `Unsupported stateful extension entry: ${customType}`);
      if (entry.type === 'custom_message') { content.parse(entry.content); z.boolean().parse(entry.display); }
    }
    ids.add(entry.id); entries.push(entry as unknown as SessionEntry);
  }
  invariant(ids.has(leaf), 'Captured active leaf missing');
  invariant(entries.some(e => e.type === 'message' && e.message.role === 'assistant'), 'Pi session has no persisted assistant response');
  // All tool calls on the selected branch must have terminal native results.
  const pending = new Set<string>();
  for (const m of buildSessionContext(entries, leaf).messages) {
    if (m.role === 'assistant') for (const block of m.content) if (block.type === 'toolCall') pending.add(block.id);
    if (m.role === 'toolResult') pending.delete(m.toolCallId);
  }
  invariant(pending.size === 0, 'Incomplete native tool activity');
  return { header, entries };
}
export function runtimeSignature(session: AgentSession, profileDigest: string) {
  const tools = session.getAllTools().filter(t => session.getActiveToolNames().includes(t.name)).map(t => ({ name: t.name, description: t.description, parameters: t.parameters, promptGuidelines: t.promptGuidelines }));
  const prompt = session.createReplacedSessionContext().getSystemPromptOptions();
  const mapping = new Map<string, string>([[session.sessionManager.getCwd(), '<cwd>']]);
  session.resourceLoader.getAgentsFiles().agentsFiles.forEach((f, i) => mapping.set(f.path, `<instruction:${i}>`));
  session.resourceLoader.getSkills().skills.forEach((s, i) => { mapping.set(s.filePath, `<skill:${i}>/SKILL.md`); mapping.set(s.baseDir, `<skill:${i}>`); });
  function relocate(value: unknown): unknown {
    if (typeof value === 'string') { let result = value; for (const [source, target] of [...mapping].sort((a, b) => b[0].length - a[0].length)) result = result.replaceAll(source, target); return result; }
    if (Array.isArray(value)) return value.map(relocate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, relocate(child)]));
    return value;
  }
  return hash(json({ profileDigest, tools, model: session.model, thinking: session.thinkingLevel, prompt: relocate(prompt) }));
}
function artifacts(entries: SessionEntry[], blobs: Blobs): Native['artifacts'] {
  const paths = new Set<string>();
  const relocations = new Map<string, string>();
  for (const entry of entries) if (entry.type === 'custom_message' && entry.customType === 'bauble:relocation' && entry.details) {
    const details = z.object({ artifacts: z.array(z.object({ source: z.string(), target: z.string(), hash: z.string() })) }).passthrough().parse(entry.details);
    for (const artifact of details.artifacts) relocations.set(artifact.source, artifact.target);
  }
  function inspect(value: unknown) { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { if (key === 'fullOutputPath') { invariant(typeof child === 'string' && isAbsolute(child), 'Invalid required full-output artifact'); paths.add(child); } else if (child && typeof child === 'object') inspect(child); } }
  inspect(entries);
  return [...paths].sort().map(source => { const current = relocations.get(source) ?? source; invariant(!forbidden(source) && !forbidden(current) && !forbidden(realpathSync(current)), `Forbidden artifact: ${source}`); return { source, hash: blobs.put(readBytes(current)) }; });
}
export function captureNative(reg: Registration, profile: Profile, blobs: Blobs, live?: AgentSession): Native {
  invariant(reg.leaf && reg.sessionHash, 'Missing trustworthy active-position/checkpoint metadata; open explicitly through bauble pi');
  const bytes = readBytes(reg.sessionFile); invariant(hash(bytes) === reg.sessionHash, 'Native session changed since managed settlement/shutdown');
  const { header, entries } = validateSession(bytes, reg.leaf, profile.testOnly);
  invariant(header.id === reg.sessionId && header.cwd === reg.cwd, 'Native registration mapping mismatch');
  const resources = snapshotProfile(profile, dirname(reg.profilePath), blobs);
  invariant(resources.digest === reg.profileDigest, 'Profile resources changed; reopen supported profile');
  if (live) {
    invariant(live.isIdle && live.pendingMessageCount === 0 && !live.isCompacting && !live.isStreaming, 'Runtime not fully settled');
    invariant(isDeepStrictEqual(JSON.parse(json(live.sessionManager.getEntries())), entries), 'Native disk/live entries disagree');
    invariant(json(live.messages) === json(buildSessionContext(entries, reg.leaf).messages), 'Native disk/live context disagrees');
    invariant(runtimeSignature(live, resources.digest) === reg.runtimeSignature, 'Runtime inputs changed');
  } else invariant(reg.cleanShutdown, 'No verified clean shutdown; contact the live control channel');
  const result: Native = { sessionId: reg.sessionId, leaf: reg.leaf, session: blobs.put(bytes), profile, profileDigest: resources.digest, resources: resources.resources, artifacts: artifacts(entries, blobs), requirements: { provider: profile.provider, model: profile.model, credentialAvailable: true, executables: profile.executables, services: profile.services }, runtimeSignature: reg.runtimeSignature };
  invariant(hash(readBytes(reg.sessionFile)) === hash(bytes), 'Native session changed during capture'); return result;
}
export function restoreNative(native: Native, blobs: Blobs, cwd: string, root: string, transferId: string) {
  const bytes = blobs.get(native.session); const original = validateSession(bytes, native.leaf, native.profile.testOnly);
  invariant(!existsSync(root), 'Native restore root exists'); privateDir(root);
  const source = join(root, 'source.jsonl'); atomicWrite(source, bytes);
  const mapped = native.artifacts.map(artifact => { const target = join(root, 'artifacts', artifact.hash); atomicWrite(target, blobs.get(artifact.hash)); return { source: artifact.source, target, hash: artifact.hash }; });
  const manager = SessionManager.forkFrom(source, cwd, join(root, 'sessions'));
  invariant(isDeepStrictEqual(JSON.parse(json(manager.getEntries())), original.entries), 'Pi fork did not preserve full entry tree');
  manager.branch(native.leaf);
  const restoredLeaf = manager.appendCustomMessageEntry('bauble:relocation', json({ protocol: 1, transferId, sourceCwd: original.header.cwd, targetCwd: cwd, artifacts: mapped, historicalPaths: 'Historical prose and tool output remain unchanged; only mappings above are relocated.' }), true, { protocol: 1, artifacts: mapped });
  const file = manager.getSessionFile(); invariant(file && existsSync(file), 'Restored session not persisted');
  invariant(manager.getEntry(restoredLeaf)?.parentId === native.leaf, 'Relocation parent mismatch');
  const reopened = SessionManager.open(file);
  invariant(reopened.getLeafId() === restoredLeaf && json(reopened.buildSessionContext()) === json(manager.buildSessionContext()), 'Pi restart active context mismatch');
  invariant(blobs.get(native.session).equals(bytes), 'Source archive changed');
  return { manager, file, restoredLeaf, mapped };
}
