import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { type Readable, type Writable } from 'node:stream';
import { z } from 'zod';
import { VERSION } from './metadata.js';
import { CliError } from './errors.js';
import { invariant } from './safe.js';
import { Request, type Rpc } from './rpc.js';

export const MAX_FRAME = 2 * 1024 * 1024;
export const STREAM_PROTOCOL = 1;
const Hello = z.object({ type: z.literal('hello'), protocol: z.literal(STREAM_PROTOCOL), version: z.literal(VERSION), capability: z.literal('rpc-stream-v1') }).strict();
export const streamHello = () => Hello.parse({ type: 'hello', protocol: STREAM_PROTOCOL, version: VERSION, capability: 'rpc-stream-v1' });
const Call = z.object({ type: z.literal('request'), id: z.number().int().positive().safe(), request: Request }).strict();
const Reply = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('response'), id: z.number().int().positive().safe(), ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ type: z.literal('response'), id: z.number().int().positive().safe(), ok: z.literal(false), error: z.literal('REMOTE_OPERATION_FAILED') }).strict(),
]);
function capabilityError() { return new CliError('STREAM_CAPABILITY', 'Remote helper is unavailable or incompatible.', 'capability', `Install Bauble ${VERSION} on both ends on the non-interactive SSH PATH. No downgrade or replay was attempted.`); }
function channelError() { return new CliError('CHANNEL_UNCERTAIN', 'Remote response channel lost or invalid; reconcile durable identifiers.', 'uncertain', 'No automatic reconnect, retransmit or replay. Recover the exact transfer or query the existing message request ID.'); }

/** At most one bounded frame is assembled; stream high-water marks supply backpressure. */
export async function* frames(input: Readable): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0);
  for await (const raw of input) {
    const bytes = Buffer.from(raw); let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start); const end = newline < 0 ? bytes.length : newline;
      invariant(pending.length + end - start <= MAX_FRAME, 'Protocol frame exceeds 2 MiB');
      pending = Buffer.concat([pending, bytes.subarray(start, end)]);
      if (newline < 0) break;
      const text = pending.toString('utf8'); invariant(Buffer.from(text).equals(pending), 'Invalid protocol UTF-8');
      const value: unknown = JSON.parse(text); pending = Buffer.alloc(0); start = newline + 1;
      yield value;
    }
  }
  invariant(pending.length === 0, 'Truncated protocol frame');
}
export function writeFrame(output: Writable, value: unknown): Promise<void> {
  const text = JSON.stringify(value); invariant(Buffer.byteLength(text) <= MAX_FRAME, 'Protocol frame exceeds 2 MiB');
  return new Promise((ok, fail) => { output.write(text + '\n', error => error ? fail(error) : ok()); });
}

/** Each admitted operation finishes even when its client/response pipe disappears. */
export async function serveStream(input: Readable, output: Writable, handle: Rpc): Promise<void> {
  let channelLost = false;
  const lost = () => { channelLost = true; input.destroy(); };
  output.on('error', lost); input.on('error', () => {});
  try {
    let handshaken = false; let sequence = 0;
    for await (const raw of frames(input)) {
      if (channelLost) break;
      if (!handshaken) { Hello.parse(raw); await writeFrame(output, streamHello()); handshaken = true; continue; }
      const call = Call.parse(raw); invariant(call.id === sequence + 1, 'Out of sequence request'); sequence = call.id;
      let response: z.infer<typeof Reply>;
      try { response = { type: 'response', id: call.id, ok: true, data: await handle(call.request) }; }
      catch { response = { type: 'response', id: call.id, ok: false, error: 'REMOTE_OPERATION_FAILED' }; }
      if (channelLost || output.destroyed) break;
      await writeFrame(output, response);
    }
    invariant(handshaken || channelLost, 'Missing stream handshake');
  } finally { output.removeListener('error', lost); }
}

export interface ManagedRpc extends Rpc { close(): void }
/** A connection is lazy, command-owned, fail-closed and never reconnects. Calls must be sequential. */
export function streamRpc(start: () => ChildProcessWithoutNullStreams, timeout = 120_000): ManagedRpc {
  let child: ChildProcessWithoutNullStreams | undefined; let failure: Error | undefined; let ready = false; let busy = false; let sequence = 0;
  let waiting: { ok(value: unknown): void; fail(error: Error): void; timer: NodeJS.Timeout } | undefined;
  const stop = (error: Error) => {
    if (failure) return; failure = error;
    if (waiting) { clearTimeout(waiting.timer); waiting.fail(failure); waiting = undefined; }
    child?.stdin.destroy();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(); const force = setTimeout(() => child?.kill('SIGKILL'), 1000); force.unref(); child.once('close', () => clearTimeout(force));
    }
  };
  const exchange = (value: unknown) => new Promise<unknown>((ok, fail) => {
    waiting = { ok, fail, timer: setTimeout(() => stop(ready ? channelError() : capabilityError()), timeout) };
    void writeFrame(child!.stdin, value).catch(() => stop(ready ? channelError() : capabilityError()));
  });
  const rpc: ManagedRpc = Object.assign(async (request: Request): Promise<unknown> => {
    Request.parse(request);
    // Validate size before allocating a connection or admitting any operation.
    invariant(Buffer.byteLength(JSON.stringify({ type: 'request', id: sequence + 1, request })) <= MAX_FRAME, 'Protocol frame exceeds 2 MiB');
    invariant(!busy, 'RPC calls must be sequential'); if (failure) throw failure; busy = true;
    try {
      if (!child) {
        try { child = start(); } catch { stop(capabilityError()); throw failure; }
        child.stderr.resume();
        child.on('error', () => stop(ready ? channelError() : capabilityError()));
        child.stdin.on('error', () => stop(ready ? channelError() : capabilityError()));
        child.on('close', () => stop(ready ? channelError() : capabilityError()));
        void (async () => {
          try {
            for await (const value of frames(child!.stdout)) {
              invariant(waiting, 'Unsolicited protocol response');
              if (!ready) Hello.parse(value); else { const reply = Reply.parse(value); invariant(reply.id === sequence, 'Response ID mismatch'); }
              const current = waiting; waiting = undefined; clearTimeout(current.timer); current.ok(value);
            }
            stop(ready ? channelError() : capabilityError());
          } catch { stop(ready ? channelError() : capabilityError()); }
        })();
        await exchange(streamHello()); if (failure) throw failure; ready = true;
      }
      sequence++;
      const response = Reply.parse(await exchange({ type: 'request', id: sequence, request }));
      if (!response.ok) throw new Error('Remote operation failed; retain durable identifiers and do not infer authority.');
      return response.data;
    } finally { busy = false; }
  }, { close() { stop(channelError()); } });
  return rpc;
}

/** Cache only within an explicit command, including preflight and follow polling. */
export function rpcScope(connect: (alias: string) => Rpc) {
  const connections = new Map<string, Rpc>(); let closed = false;
  return {
    connect(alias: string): Rpc { invariant(!closed, 'RPC command scope is closed'); let rpc = connections.get(alias); if (!rpc) { rpc = connect(alias); connections.set(alias, rpc); } return rpc; },
    close() { if (closed) return; closed = true; for (const rpc of connections.values()) if ('close' in rpc && typeof rpc.close === 'function') rpc.close(); connections.clear(); },
  };
}
