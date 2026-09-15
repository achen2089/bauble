import { spawn } from 'node:child_process';
import { createConnection, createServer, type Server } from 'node:net';
import { chmodSync } from 'node:fs';
import { z } from 'zod';
import { Alias } from './schema.js';
import { invariant, json, removeFile } from './safe.js';
const MAX_MESSAGE = 2 * 1024 * 1024;
export const Request = z.object({ operation: z.enum(['probe', 'manifest', 'blob', 'ready', 'activate', 'status', 'revoke', 'attach', 'message-check', 'message', 'message-status', 'log', 'capture', 'fence', 'download', 'approve', 'finish']), root: z.string().max(4096), data: z.unknown() }).strict();
export type Request = z.infer<typeof Request>;
export type Rpc = (request: Request) => Promise<unknown>;
export function ssh(alias: string): Rpc {
  Alias.parse(alias);
  return request => new Promise((ok, fail) => {
    const payload = json(Request.parse(request)); invariant(Buffer.byteLength(payload) <= MAX_MESSAGE, 'Protocol message exceeds 2 MiB limit');
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', alias, 'bauble _helper'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0); let stderr = '';
    const timer = setTimeout(() => { child.kill(); fail(new Error('SSH timeout; ownership unknown until receipt reconciliation')); }, 120_000);
    child.on('error', e => { clearTimeout(timer); fail(e); });
    child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]); if (stdout.length > MAX_MESSAGE) { child.kill(); fail(new Error('Oversized protocol response')); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) { fail(new Error(`SSH helper failed (${code}): ${stderr || stdout.toString().slice(0, 4000)}. Install compatible bauble on non-interactive SSH PATH; setup never provisions.`)); return; } try { const response = JSON.parse(stdout.toString()); if (!response.ok) throw new Error(response.error); ok(response.data); } catch (e) { fail(e); } });
    child.stdin.on('error', fail); child.stdin.end(payload);
  });
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
export function control(path: string, data: unknown): Promise<unknown> {
  return new Promise((ok, fail) => { const socket = createConnection(path); let result = Buffer.alloc(0); socket.setTimeout(120_000);
    socket.on('connect', () => { const payload = JSON.stringify(data) + '\n'; if (Buffer.byteLength(payload) > MAX_MESSAGE) { socket.destroy(new Error('Control request exceeds 2 MiB limit')); return; } socket.write(payload); }); socket.on('data', chunk => { result = Buffer.concat([result, chunk]); if (result.length > MAX_MESSAGE) socket.destroy(new Error('Oversized control response')); });
    socket.on('end', () => { try { const value = JSON.parse(result.toString()); invariant(value.ok, value.error); ok(value.data); } catch (e) { fail(e); } }); socket.on('error', fail); socket.on('timeout', () => socket.destroy(new Error('Live control timeout; do not infer shutdown')));
  });
}
export const CHUNK = 384 * 1024;
