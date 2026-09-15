import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import type { Guard } from './guard.js';
export interface PiHost {
  guard: Guard;
  handoff(host?: string, approve?: (text: string) => Promise<boolean>): Promise<void>;
  observe(state: 'running' | 'idle' | 'waiting_for_input' | 'exited'): void;
  shutdown(): Promise<void>;
}
export function baubleExtension(host: PiHost) {
  return (pi: ExtensionAPI) => {
    let context: ExtensionContext | undefined;
    let removeInput: (() => void) | undefined;
    let approval: ((value: boolean) => void) | undefined;
    let display: string[] = []; let offset = 0; let render: (() => void) | undefined;
    pi.on('session_start', (_event, ctx) => {
      context = ctx; removeInput?.();
      removeInput = ctx.ui.onTerminalInput(data => {
        if (approval) {
          if (data === 'y') approval(true); else if (data === 'n' || data === '\u001b') approval(false);
          else if (data === 'j' || data === '\u001b[B') { offset = Math.min(Math.max(0, display.length - 10), offset + 1); render?.(); }
          else if (data === 'k' || data === '\u001b[A') { offset = Math.max(0, offset - 1); render?.(); }
          return { consume: true };
        }
        if (host.guard.blocked()) return { consume: true };
        return undefined;
      });
    });
    pi.on('input', () => host.guard.blocked() ? { action: 'handled' as const } : { action: 'continue' as const });
    pi.on('tool_call', () => { try { host.guard.check(); } catch { return { block: true, reason: 'Bauble fenced/frozen or storage unavailable', terminate: true }; } });
    pi.on('user_bash', () => host.guard.blocked() ? { result: { output: 'Bauble frozen/fenced', exitCode: 1, cancelled: true, truncated: false } } : undefined);
    pi.on('session_before_switch', () => host.guard.blocked() ? { cancel: true } : undefined);
    pi.on('session_before_fork', () => host.guard.blocked() ? { cancel: true } : undefined);
    pi.on('session_before_tree', () => host.guard.blocked() ? { cancel: true } : undefined);
    pi.on('session_before_compact', () => host.guard.blocked() ? { cancel: true } : undefined);
    pi.on('agent_start', () => host.observe('running'));
    pi.on('agent_settled', () => host.observe('idle'));
    pi.on('ui_prompt_start', () => host.observe('waiting_for_input'));
    pi.on('ui_prompt_end', () => host.observe('idle'));
    pi.on('session_shutdown', async event => { removeInput?.(); if (event.reason === 'quit') await host.shutdown(); });
    pi.registerCommand('bauble', { description: 'Approve a native session/workspace handoff', handler: async (args, ctx) => {
      await host.handoff(args.trim() || undefined, async text => {
        display = text.split('\n'); offset = 0;
        const approved = await ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
          approval = value => { approval = undefined; done(value); }; render = () => tui.requestRender();
          return { invalidate() {}, render(width) { return new Text(['Bauble transfer approval — j/k scroll, y approve, n cancel', ...display.slice(offset, offset + 16), `${offset + 1}/${display.length} lines`].join('\n'), 1, 1).render(width); }, handleInput() {} };
        }, { overlay: true });
        render = undefined; return approved;
      });
      context?.shutdown();
    } });
  };
}
export default function unsupported(pi: ExtensionAPI) {
  pi.registerCommand('bauble', { description: 'Requires the guarded Bauble launcher', handler: async (_args, ctx) => { ctx.ui.notify('Use bauble pi. Loading this extension into an unmanaged Pi runtime cannot certify ownership/profile fidelity.', 'error'); } });
}
