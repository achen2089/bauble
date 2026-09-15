import { spawn } from 'node:child_process';
import { createConnection, createServer, type Server } from 'node:net';
import { chmodSync } from 'node:fs';
import { streamRpc, type ManagedRpc } from './stream.js';
import { Alias } from './schema.js';
import { invariant, json } from './safe.js';
const MAX_MESSAGE = 2 * 1024 * 1024;
export { Request, type Rpc } from './rpc.js';
/** The caller owns this connection and must close it at command completion. */
export function ssh(alias: string): ManagedRpc {
  Alias.parse(alias);
  return streamRpc(() => spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', alias, 'bauble _helper-stream'], { stdio: ['pipe', 'pipe', 'pipe'] }));
}
function parseWireJson(bytes: Buffer): unknown {
  const text = bytes.toString('utf8'); invariant(Buffer.from(text).equals(bytes), 'Invalid protocol UTF-8');
  try { return JSON.parse(text); } catch { throw new Error('Invalid protocol JSON'); }
}
export async function readMessage(input: NodeJS.ReadableStream) { let bytes = Buffer.alloc(0); for await (const chunk of input) { bytes = Buffer.concat([bytes, Buffer.from(chunk)]); invariant(bytes.length <= MAX_MESSAGE, 'Protocol size limit exceeded'); } return parseWireJson(bytes); }
export async function controlServer(path: string, handler: (data: unknown) => Promise<unknown>): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, socket => {
    // Losing the response channel cannot cancel or replay an already admitted request.
    socket.on('error', () => {}); socket.setTimeout(120_000, () => socket.destroy());
    let pending = Buffer.alloc(0); let handled = false;
    const attempt = (ended = false) => {
      if (handled) return;
      let request: unknown;
      try { request = parseWireJson(pending); }
      catch {
        // Older clients send pretty JSON. A newline is not proof the whole object arrived.
        if (ended) { handled = true; socket.end(json({ ok: false, error: 'Invalid control JSON' })); }
        return;
      }
      handled = true;
      void (async () => {
        try { socket.end(json({ ok: true, data: await handler(request) })); }
        catch (error) { socket.end(json({ ok: false, error: String(error) })); }
      })();
    };
    socket.on('data', chunk => {
      if (handled) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_MESSAGE) socket.destroy(); else if (pending.includes(10)) attempt();
    });
    socket.on('end', () => attempt(true));
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(path, ok); }); chmodSync(path, 0o600); return server;
}
export class ControlChannelError extends Error {
  constructor(readonly admissionPossible: boolean) { super('Live control response unavailable; do not infer shutdown.'); }
}
export function control(path: string, data: unknown): Promise<unknown> {
  return new Promise((ok, fail) => {
    const payload = JSON.stringify(data) + '\n'; invariant(Buffer.byteLength(payload) <= MAX_MESSAGE, 'Control request exceeds 2 MiB limit');
    const socket = createConnection(path); let result = Buffer.alloc(0); let admissionPossible = false; let settled = false;
    const lost = () => { if (!settled) { settled = true; fail(new ControlChannelError(admissionPossible)); } socket.destroy(); };
    socket.setTimeout(120_000);
    socket.on('connect', () => { admissionPossible = true; socket.write(payload); });
    socket.on('data', chunk => { result = Buffer.concat([result, chunk]); if (result.length > MAX_MESSAGE) lost(); });
    socket.on('end', () => {
      if (settled) return;
      let value: { ok: boolean; data?: unknown; error?: unknown };
      try {
        const raw = parseWireJson(result);
        invariant(raw !== null && typeof raw === 'object' && 'ok' in raw && typeof raw.ok === 'boolean', 'Invalid control response');
        value = raw as typeof value;
      } catch { lost(); return; }
      settled = true;
      if (value.ok) ok(value.data); else fail(new Error(typeof value.error === 'string' ? value.error : 'Live control operation rejected'));
    });
    socket.on('error', lost); socket.on('timeout', lost); socket.on('close', lost);
  });
}
export const CHUNK = 384 * 1024;
