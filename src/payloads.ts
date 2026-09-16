import type { Prepared } from './output.js';
import type { MessageResult } from './message.js';
import type { LogChunk } from './log.js';
import type { Config } from './schema.js';
import type { inspect, sessions, listTransfers, status, transferSummary } from './queries.js';
import type { setup } from './commands.js';
export interface ReturnedPayload { returned: true; transferId: string | null; sessionId: string; sessionFile: string; cwd: string; profilePath: string }
export type TransferPayload = ReturnType<typeof transferSummary>;
/** Version 1 public data objects. Transport helper responses are deliberately separate. */
export interface CommandPayloads {
  help: { help: string };
  version: { version: string; piVersion: string };
  docs: { topic: string; markdown: string } | { topics: string[] };
  'host list': { defaultHost: string | null; hosts: Array<{ alias: string } & Config['hosts'][string]> };
  'host add': Awaited<ReturnType<typeof setup>>;
  'host default': { defaultHost: string };
  setup: Awaited<ReturnType<typeof setup>>;
  pi: { closed: true };
  run: Prepared | TransferPayload;
  send: Prepared | TransferPayload;
  sessions: ReturnType<typeof sessions>;
  ls: ReturnType<typeof listTransfers>;
  status: Awaited<ReturnType<typeof status>>;
  inspect: ReturnType<typeof inspect>;
  approve: { transferId: string; digest: string; approved: true };
  message: MessageResult;
  'message-status': MessageResult;
  attach: { transferId: string; detached: true };
  open: { windowRequested: true } | { transferId: string; detached: true };
  log: { transferId: string; sequence: number } & LogChunk;
  pull: Prepared | ReturnedPayload;
  recover: Prepared | ReturnedPayload | TransferPayload;
}
export type OperationalData = CommandPayloads[Exclude<keyof CommandPayloads, 'help' | 'version' | 'docs' | 'log'>];
