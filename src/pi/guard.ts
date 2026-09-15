import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession, SessionManager, SettingsManager, AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import { invariant } from '../safe.js';
import type { Store } from '../store.js';
export class Guard {
  phase: 'open' | 'settling' | 'frozen' = 'open';
  readonly accepted = new AsyncLocalStorage<boolean>();
  readonly pending = new Set<Promise<unknown>>();
  private readonly messageContext = new AsyncLocalStorage<symbol>();
  private messageToken?: symbol;
  get messageReserved() { return this.messageToken !== undefined; }
  reserveMessage(session: AgentSession) {
    this.check();
    invariant(!this.pending.size && session.isIdle && !session.isStreaming && !session.isCompacting && !session.isRetrying && !session.isBashRunning && !session.hasPendingBashMessages && !session.pendingMessageCount, 'Runtime busy; wait until fully idle, then explicitly retry with a NEW request ID after confirmed rejection');
    const token = Symbol('message'); this.messageToken = token;
    return {
      run: <T>(fn: () => T) => this.messageContext.run(token, fn),
      release: () => { invariant(this.messageToken === token, 'Message reservation changed'); this.messageToken = undefined; }
    };
  }
  onMutation?: () => void;
  private recordMutation() { try { this.check(true); this.onMutation?.(); } catch (e) { this.phase = 'frozen'; throw e; } }
  constructor(readonly store: Store, readonly lineage: string, readonly generation: number) {}
  check(mutation = false) {
    const token = this.messageContext.getStore();
    invariant(token === this.messageToken, token ? 'Expired message reservation' : 'Runtime busy with a Bauble message; wait until fully idle');
    const owner = this.store.owner(this.lineage);
    invariant(owner.generation === this.generation && ['owned', 'frozen'].includes(owner.state), 'Bauble ownership fenced or changed');
    invariant(this.phase !== 'frozen' && (this.phase === 'open' || this.accepted.getStore()), 'Bauble session frozen: no new work or mutation');
    invariant(owner.state === 'owned' || (this.phase === 'settling' && this.accepted.getStore()), 'Bauble durable freeze');
  }
  blocked() { try { this.check(); return false; } catch { return true; } }
  wrap(object: object, names: string[], track = false) {
    const target = object as Record<string, unknown>;
    for (const name of names) {
      const original = target[name]; invariant(typeof original === 'function', `Pinned Pi guard method missing: ${name}`);
      target[name] = (...args: unknown[]) => {
        this.check(true);
        return this.accepted.run(true, () => {
          const result: unknown = original.apply(object, args);
          if (result instanceof Promise) {
            const recorded = result.then(value => { this.recordMutation(); return value; });
            if (track) { this.pending.add(recorded); void recorded.then(() => this.pending.delete(recorded), () => this.pending.delete(recorded)); }
            return recorded;
          }
          this.recordMutation(); return result;
        });
      };
    }
  }
  guardManager(manager: SessionManager) {
    this.wrap(manager, ['setSessionFile', 'newSession', 'appendMessage', 'appendThinkingLevelChange', 'appendModelChange', 'appendCompaction', 'appendCustomEntry', 'appendSessionInfo', 'appendCustomMessageEntry', 'appendLabelChange', 'branch', 'resetLeaf', 'branchWithSummary', 'createBranchedSession']);
  }
  guardSettings(settings: SettingsManager) {
    // Public setters are version-pinned and all checked; unknown setters do not become an implicit bypass.
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(settings)).filter(n => n.startsWith('set') || n === 'applyOverrides');
    this.wrap(settings, names);
  }
  guardSession(session: AgentSession) {
    this.wrap(session, ['steer', 'followUp', 'sendCustomMessage', 'sendUserMessage', 'executeBash', 'compact', 'navigateTree', 'reload', 'setModel', 'cycleModel'], true);
    this.wrap(session, ['setThinkingLevel', 'cycleThinkingLevel', 'setActiveToolsByName', 'setScopedModels', 'setSteeringMode', 'setFollowUpMode', 'setAutoCompactionEnabled', 'setAutoRetryEnabled', 'setSessionName', 'recordBashResult', 'clearQueue', 'exportToJsonl', 'exportToHtml']);
    const prompt = session.prompt.bind(session);
    session.prompt = (text, options) => { this.check(); if (options?.expandPromptTemplates !== false && (text === '/bauble' || text.startsWith('/bauble '))) return prompt(text, options); return this.accepted.run(true, () => { const result = prompt(text, options); this.pending.add(result); void result.then(() => this.pending.delete(result), () => this.pending.delete(result)); return result; }); };
  }
  guardRuntime(runtime: AgentSessionRuntime) { this.wrap(runtime, ['newSession', 'switchSession', 'fork', 'importFromJsonl'], true); }
  async freeze(session: AgentSession) {
    this.check(); this.phase = 'settling';
    await Promise.all([...this.pending]); await session.waitForIdle();
    invariant(session.isIdle && !session.isBashRunning && !session.hasPendingBashMessages && !session.isRetrying && !session.pendingMessageCount, 'Pi did not reach a complete settled boundary');
    await session.settingsManager.flush(); invariant(!session.settingsManager.drainErrors().length, 'Settings persistence failed');
    this.store.lock(this.lineage, () => { const owner = this.store.owner(this.lineage); invariant(owner.state === 'owned' && owner.generation === this.generation, 'Ownership changed during settlement'); this.store.setOwner({ ...owner, state: 'frozen' }); });
    this.phase = 'frozen';
  }
  unfreeze() { this.store.lock(this.lineage, () => { const owner = this.store.owner(this.lineage); invariant(['frozen', 'owned'].includes(owner.state) && owner.generation === this.generation, 'Cannot unfreeze fenced owner'); this.store.setOwner({ ...owner, state: 'owned' }); }); this.phase = 'open'; }
}
