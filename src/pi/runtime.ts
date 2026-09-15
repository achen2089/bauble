import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, ModelRuntime, InteractiveMode, type AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Store } from '../store.js';
import { type Profile, type Registration } from '../schema.js';
import { hash, invariant, json, listFiles, privateDir, readBytes } from '../safe.js';
import { readProfile, snapshotProfile, checkRequirements } from './profile.js';
import { Guard } from './guard.js';
import { baubleExtension, type PiHost } from './extension.js';
import { fixtureProvider } from './fixture.js';
import { runtimeSignature, validateSession } from './native.js';

import { processIdentity, processMatches } from '../process.js';
export { processIdentity, processMatches } from '../process.js';
export interface Managed {
  runtime: AgentSessionRuntime; guard: Guard; registration: Registration; profile: Profile;
  settled(): Promise<Registration>; close(): Promise<void>; run(): Promise<void>;
}
export async function createManaged(options: { store: Store; profilePath: string; cwd: string; session?: string; manager?: SessionManager; registration?: Registration; handoff?: PiHost['handoff']; observe?: PiHost['observe']; allowTest?: boolean; fresh?: { lineageId: string; generation: number; parentTransfer: string; name?: string } }): Promise<Managed> {
  process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1'; process.env.PI_TELEMETRY = '0';
  process.umask(0o077);
  const { store } = options; const profile = readProfile(options.profilePath);
  invariant(!profile.testOnly || options.allowTest === true, 'Test-only profile requires explicit BAUBLE_TEST_MODE=1 or isolated test harness');
  if (profile.testOnly) invariant(profile.provider === 'bauble-fixture' && profile.model === 'deterministic', 'Invalid fixture profile');
  await checkRequirements(profile);
  const snapshot = snapshotProfile(profile, dirname(options.profilePath), store.blobs);
  let reg = options.registration;
  if (!reg && options.session) { try { reg = store.registration(options.session); } catch { invariant(existsSync(options.session), 'Unknown registered session ID/path'); } }
  if (reg) { invariant(reg.profileDigest === snapshot.digest, 'Managed profile changed'); invariant(!processMatches(reg) || reg.pid === process.pid, 'Session already has a live runtime'); const owner = store.owner(reg.lineageId); invariant(owner.state === 'owned' && owner.generation === reg.generation, 'Session lineage is fenced/frozen'); }
  let manager = options.manager;
  if (!manager) {
    if (options.session || reg) {
      const path = reg?.sessionFile ?? resolve(options.session!); const bytes = readBytes(path);
      const last = JSON.parse(bytes.toString().trim().split('\n').at(-1)!); validateSession(bytes, reg?.leaf ?? last.id, profile.testOnly);
      manager = SessionManager.open(path); if (reg?.leaf) manager.branch(reg.leaf);
    } else { manager = SessionManager.create(options.cwd, options.fresh ? join(store.root, 'runs', options.fresh.parentTransfer, 'native', 'sessions') : join(store.root, 'native-sessions')); if (options.fresh?.name) manager.appendSessionInfo(options.fresh.name); }
  }
  const lineage = reg?.lineageId ?? options.fresh?.lineageId ?? randomUUID(); const generation = reg?.generation ?? options.fresh?.generation ?? 0;
  if (!reg && !options.fresh) store.setOwner({ lineageId: lineage, generation, transferId: null, state: 'owned' });
  const guard = new Guard(store, lineage, generation); guard.check();
  const runtimeLock = join(store.root, 'runtime-locks', lineage); privateDir(dirname(runtimeLock));
  try { mkdirSync(runtimeLock, { mode: 0o700 }); } catch { throw new Error('Lineage runtime lock exists; reconcile explicitly, never automatically restart a possibly live runtime'); }
  let runtime: AgentSessionRuntime | undefined; let closed = false;
  const shutdown = async () => {
    if (closed || !runtime) return; closed = true;
    try {
      await runtime.session.waitForIdle(); await runtime.session.settingsManager.flush();
      invariant(!runtime.session.settingsManager.drainErrors().length, 'Settings persistence failed');
      if (existsSync(runtime.session.sessionFile!)) {
        reg = { ...store.registration(reg!.sessionFile), leaf: runtime.session.sessionManager.getLeafId(), sessionHash: hash(readBytes(runtime.session.sessionFile!)), cleanShutdown: true };
        store.register(reg);
      }
      options.observe?.('exited');
    } finally { rmdirSync(runtimeLock); }
  };
  try {
    const agentDir = join(store.root, 'profile-agent'); privateDir(agentDir);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: join(agentDir, 'no-model-overrides.json'), modelsStorePath: join(agentDir, 'models-store.json'), ...(profile.testOnly ? { credentials: new InMemoryCredentialStore() } : { authPath: join(homedir(), '.pi/agent/auth.json') }) });
    const createRuntime: Parameters<typeof createAgentSessionRuntime>[0] = async ({ cwd, sessionManager, sessionStartEvent }) => {
      guard.check();
      // This factory is used by every replacement; unmanaged replacement is rejected before construction.
      invariant(sessionManager === manager, 'Controlled profile: use a separate bauble pi invocation for new/resume/fork/import; active lineage replacement is disabled');
      invariant(snapshotProfile(profile, dirname(options.profilePath), store.blobs).digest === snapshot.digest, 'Profile contents changed before runtime creation');
      guard.guardManager(sessionManager);
      const settings = SettingsManager.inMemory({ ...profile.settings, enableInstallTelemetry: false, enableAnalytics: false, packages: [], extensions: [], skills: [], prompts: [], themes: [], defaultProjectTrust: 'never' });
      const contextFiles = profile.instructions.flatMap(input => { const path = resolve(dirname(options.profilePath), input); return lstatSync(path).isDirectory() ? listFiles(path).map(p => ({ path: join(path, p), content: readBytes(join(path, p)).toString() })) : [{ path, content: readBytes(path).toString() }]; });
      const host: PiHost = { guard, handoff: options.handoff ?? (async () => { throw new Error('Handoff unavailable in this embedded test runtime'); }), observe: options.observe ?? (() => {}), shutdown };
      const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: settings, modelRuntime, resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [baubleExtension(host), ...(profile.testOnly ? [fixtureProvider] : [])], additionalSkillPaths: profile.skills.map(p => resolve(dirname(options.profilePath), p)), additionalPromptTemplatePaths: profile.prompts.map(p => resolve(dirname(options.profilePath), p)), agentsFilesOverride: () => ({ agentsFiles: contextFiles }), systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [] } });
      invariant(!services.diagnostics.some(d => d.type === 'error') && !services.resourceLoader.getExtensions().errors.length, 'Controlled resource loading failed');
      invariant(!services.resourceLoader.getSkills().diagnostics.length && !services.resourceLoader.getPrompts().diagnostics.length, 'Missing/conflicting controlled resource');
      const model = services.modelRuntime.getModel(profile.provider, profile.model); invariant(model, 'Required model absent; fallback forbidden');
      invariant(await services.modelRuntime.checkAuth(profile.provider), `Configure ${profile.provider} credentials independently on this machine`);
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: profile.thinking, scopedModels: [{ model, thinkingLevel: profile.thinking }], tools: profile.tools });
      invariant(!result.modelFallbackMessage && result.session.model?.id === profile.model && result.session.thinkingLevel === profile.thinking, 'Model/thinking fallback forbidden');
      guard.guardSettings(settings); guard.guardSession(result.session);
      return { ...result, services, diagnostics: services.diagnostics };
    };
    runtime = await createAgentSessionRuntime(createRuntime, { cwd: manager.getCwd(), agentDir, sessionManager: manager });
    guard.guardRuntime(runtime);
    // Replacement is disabled BEFORE Pi creates/copies a prospective session file.
    for (const name of ['newSession', 'switchSession', 'fork', 'importFromJsonl'] as const) Object.defineProperty(runtime, name, { value: async () => { guard.check(); throw new Error('Session replacement disabled in controlled profile; launch bauble pi --session explicitly'); } });
    const signature = runtimeSignature(runtime.session, snapshot.digest);
    if (reg) invariant(reg.runtimeSignature === signature, 'Native runtime requirements/tool schema mismatch');
    const socketDir = join(tmpdir(), `bauble-${process.getuid!()}`); privateDir(socketDir);
    invariant(lstatSync(socketDir).uid === process.getuid!() && (lstatSync(socketDir).mode & 0o077) === 0, 'Control socket directory must be private and owned by this user');
    reg = { lineageId: lineage, generation, parentTransfer: reg?.parentTransfer ?? options.fresh?.parentTransfer ?? null, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!, cwd: manager.getCwd(), leaf: manager.getLeafId(), profileDigest: snapshot.digest, runtimeSignature: signature, cleanShutdown: false, sessionHash: existsSync(manager.getSessionFile()!) ? hash(readBytes(manager.getSessionFile()!)) : null, pid: process.pid, nonce: randomUUID(), start: processIdentity(), socket: join(socketDir, `${hash(store.root + lineage).slice(0, 24)}.sock`), profilePath: resolve(options.profilePath) };
    store.register(reg);
    guard.onMutation = () => {
      reg = { ...reg!, leaf: manager!.getLeafId(), sessionHash: existsSync(manager!.getSessionFile()!) ? hash(readBytes(manager!.getSessionFile()!)) : null, cleanShutdown: false };
      store.register(reg);
    };
    const managed: Managed = { runtime, guard, registration: reg, profile,
      async settled() {
        await guard.freeze(runtime!.session);
        invariant(runtimeSignature(runtime!.session, snapshot.digest) === reg!.runtimeSignature, 'Profile model/thinking/tool requirements changed; reopen with explicit matching profile');
        reg = { ...reg!, leaf: runtime!.session.sessionManager.getLeafId(), sessionHash: hash(readBytes(runtime!.session.sessionFile!)), cleanShutdown: false };
        store.register(reg); managed.registration = reg; return reg;
      },
      async close() { await shutdown(); await runtime!.dispose(); },
      async run() { const mode = new InteractiveMode(runtime!, { migratedProviders: [] }); await mode.run(); }
    };
    return managed;
  } catch (e) { if (!closed) rmdirSync(runtimeLock); throw e; }
}
