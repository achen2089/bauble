import { captureObservation } from './capture-intent.js';
import { Store } from './store.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import type { Parsed } from './registry.js';
import { action, approvalActions, type NextAction, type OperationContext } from './output.js';
import { inspect, listTransfers, nextFor, resolveTransfer, sessions, status, transferSummary } from './queries.js';
import { ssh, type Rpc } from './transport.js';
import { rpcScope } from './stream.js';
import type { OperationalData } from './payloads.js';
export interface Execution { data: OperationalData; nextActions: NextAction[]; exitCode?: number; error?: { code: string; message: string; hint: string | null } }
export interface ExecutionContext extends OperationContext { connect?: (alias: string) => Rpc; signal?: AbortSignal }
export async function execute(parsed: Parsed, context: ExecutionContext): Promise<Execution> {
  const scope = rpcScope(context.connect ?? ssh); const abort = () => scope.close(); context.signal?.addEventListener('abort', abort, { once: true });
  try { return await executeCommand(parsed, { ...context, connect: scope.connect }); }
  finally { context.signal?.removeEventListener('abort', abort); scope.close(); }
}
async function executeCommand(parsed: Parsed, context: ExecutionContext): Promise<Execution> {
  const { command, args, values: v } = parsed; const s = (key: string) => v[key] as string | undefined; const b = (key: string) => Boolean(v[key]); const array = (key: string) => v[key] as string[] | undefined;
  const done = (data: OperationalData, nextActions: NextAction[] = []): Execution => ({ data, nextActions });
  const connect = context.connect ?? ssh;
  if (command.startsWith('host ') || command === 'setup') {
    const { hostCommand, bootstrapConfig } = await import('./hosts.js');
    if (command === 'setup' || command === 'host add') { await bootstrapConfig(s('profile')); return done(await (await import('./commands.js')).setup(args[0]!, b('default'), s('code-root'), connect)); }
    return done((await hostCommand(command.slice(5), args[0]))!);
  }
  if (command === 'sessions') return done(sessions());
  if (command === 'ls') return done(listTransfers());
  if (command === 'run' || command === 'send') {
    const store = new Store();
    const result = command === 'run'
      ? await (await import('./run.js')).runTask({ cwd: s('cwd') ?? args[0], task: s('task'), prompt: s('prompt'), context: array('context'), host: s('host'), name: s('name'), profile: s('profile'), autoApprove: b('auto-approve'), prepare: b('prepare'), sensitive: array('include-sensitive'), history: array('include-history') }, store, connect, context)
      : await (await import('./commands.js')).send({ session: s('session'), checkpoint: s('checkpoint'), host: s('host'), instructionFile: s('instruction-file'), approvalDigest: s('approval-digest'), prepare: b('prepare'), sensitive: array('include-sensitive'), history: array('include-history') }, store, undefined, context, connect);
    if ('prepared' in result) return done(result, approvalActions(result.transferId, result.digest));
    return transferResult(store, result.transferId);
  }
  if (command === 'pi') { const store = new Store(); const config = loadConfig(); let profilePath = config.profile; if (s('session')) { try { profilePath = store.registration(s('session')!).profilePath; } catch { /* Controlled launcher validates explicit bare-path adoption. */ } } await (await import('./commands.js')).hostRuntime({ store, profilePath, cwd: process.cwd(), session: s('session'), allowTest: process.env.BAUBLE_TEST_MODE === '1' }); return done({ closed: true }); }
  const selection = resolveTransfer(args[0]!); const id = selection.id;
  const readOnly = ['status', 'inspect', 'log', 'open', 'attach', 'message-status'].includes(command); const store = readOnly ? selection.store : new Store(selection.store.root);
  if (command === 'status') return done(await status(store, id, b('refresh'), connect), nextFor(store, id));
  const capture = captureObservation(store, id); if (capture && capture.checkpoint !== 'complete') throw new CliError('CAPTURE_UNCERTAIN', 'Capture checkpoint is missing or partial; never recapture or unfreeze.', 'uncertain', 'Read status for this exact intent and inspect recorded registration/owner bindings.', capture);
  if (command === 'inspect') return done(inspect(store, id), nextFor(store, id));
  if (command === 'approve') { await (await import('./approval.js')).approve(store, id, s('approval-digest')); return done({ transferId: id, digest: store.manifest(id).digest, approved: true }, [action('Resume exact snapshot when authorized', 'mutate', 'recover', id)]); }
  if (command === 'message' || command === 'message-status') {
    const messages = await import('./message.js');
    const result = command === 'message' ? await messages.messageSession(id, args[1]!, s('request-id'), store, { connect, onIntent: requestId => context.onDurable?.({ transferId: id, requestId, delivery: 'intent' }) }) : await messages.messageStatus(id, s('request-id')!, store, { connect });
    const next = [action('Query this request without retransmitting', 'read', 'message-status', id, '--request-id', result.requestId)];
    if (result.state === 'accepted') return done(result, next);
    const uncertain = result.state === 'uncertain'; return { data: result, nextActions: next, exitCode: uncertain ? 4 : 1, error: { code: uncertain ? 'DELIVERY_UNCERTAIN' : result.state === 'absent' ? 'MESSAGE_ABSENT' : result.reason === 'busy' ? 'BUSY' : 'MESSAGE_REJECTED', message: `Message delivery ${result.state}; task completion is not tracked.`, hint: 'Do not automatically resend or choose a new request ID to bypass uncertainty.' } };
  }
  if (command === 'open' || command === 'attach') { const open = await import('./open.js'); if (command === 'attach') { await open.attachResolved(await open.resolveAttachment(id, store, { connect }), store, { connect }); return done({ transferId: id, detached: true }); } const result = await open.openSession(id, b('here'), store, { connect }); return done(result ?? { transferId: id, detached: true }); }
  if (command === 'pull' || command === 'recover') {
    context.onDurable?.({ transferId: id });
    const commands = await import('./commands.js'); const options = { ...context, connect, approvalDigest: s('approval-digest'), autoApprove: b('auto-approve'), prepare: b('prepare') };
    const result = command === 'pull' ? await commands.pull(id, s('approval-digest'), store, options) : await commands.recover(id, b('cancel'), store, options);
    if ('prepared' in result) return done(result, approvalActions(result.transferId, result.digest));
    if ('sessionFile' in result) return done({ returned: true, transferId: result.parentTransfer, sessionId: result.sessionId, sessionFile: result.sessionFile, cwd: result.cwd, profilePath: result.profilePath }, [action('Explicitly reopen after confirmed old-runtime exit', 'interactive', 'pi', '--session', result.sessionFile)]);
    return transferResult(store, result.transferId);
  }
  throw new CliError('USAGE', 'Unsupported command.', 'usage');
  function transferResult(store: Store, id: string): Execution {
    const row = transferSummary(store, id); const uncertain = row.phase === 'unknown' || row.phase === 'launch_intent';
    return { data: row, nextActions: nextFor(store, id), ...(uncertain ? { exitCode: 4, error: { code: 'AUTHORITY_UNCERTAIN', message: 'Readiness is unconfirmed; no restart or replay.', hint: 'Recover this exact ID.' } } : row.execution === 'failed' ? { exitCode: 1, error: { code: 'EXECUTION_FAILED', message: 'The runtime recorded failed execution; task completion is not inferred.', hint: 'Inspect status and logs for the existing ID; do not automatically restart.' } } : {}) };
  }
}
