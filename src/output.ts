import { CliError } from './errors.js';
export interface NextAction { description: string; argv: string[]; effect: 'read' | 'approve' | 'mutate' | 'interactive' }
export interface Envelope<T extends object = object> { schemaVersion: 1; command: string; ok: boolean; data: T | null; error: { code: string; message: string; hint: string | null } | null; nextActions: NextAction[] }
export interface Prepared { prepared: true; transferId: string; digest: string; checkpoint: string; destination: string; sourceFrozen: boolean; originalId?: string; reverseId?: string; remoteFrozen?: boolean }
export type ProgressStage = 'capture' | 'verify' | 'upload' | 'download' | 'readiness' | 'reconcile';
export interface OperationContext { interactive?: boolean; progress?: (stage: ProgressStage, detail?: string) => void; onDurable?: (data: object) => void }
export const action = (description: string, effect: NextAction['effect'], ...argv: string[]): NextAction => ({ description, effect, argv: ['bauble', ...argv] });
export function approvalActions(id: string, digest: string): NextAction[] { return [action('Inspect sensitive immutable inventory', 'read', 'inspect', id), action('After authorized review only, record exact approval', 'approve', 'approve', id, '--approval-digest', digest), action('Resume this exact snapshot; never recapture', 'mutate', 'recover', id)]; }
export function envelope<T extends object>(command: string, data: T, nextActions: NextAction[] = []): Envelope<T> { return { schemaVersion: 1, command, ok: true, data, error: null, nextActions }; }
export function failure(command: string, error: unknown): { value: Envelope; exitCode: number } {
  if (error instanceof CliError) return { value: { schemaVersion: 1, command, ok: false, data: error.data, error: { code: error.code, message: error.message, hint: error.hint }, nextActions: error.nextActions }, exitCode: error.exitCode };
  return { value: { schemaVersion: 1, command, ok: false, data: null, error: { code: 'FAILED', message: 'Operation failed; authority or delivery must not be inferred from this failure.', hint: 'Retain existing IDs and state. Inspect status and bauble docs recovery; do not replay or delete locks.' }, nextActions: [] }, exitCode: 1 };
}
export function printEnvelope(value: Envelope, asJson: boolean) {
  if (asJson) { process.stdout.write(JSON.stringify(value) + '\n'); return; }
  if (value.error) { process.stderr.write(`${value.error.code}: ${value.error.message}\n${value.error.hint ?? ''}\n`); }
  if (value.data) process.stdout.write(human(value.command, value.data) + '\n');
  for (const next of value.nextActions) process.stdout.write(`${next.description}: ${next.argv.map(quote).join(' ')}\n`);
}
function quote(value: string) { return /^[a-zA-Z0-9_./:=@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`; }
function human(command: string, data: object): string {
  const value = data as Record<string, unknown>;
  if (typeof value.markdown === 'string') return value.markdown;
  if (typeof value.help === 'string') return value.help;
  if (command === 'version') return `Bauble ${value.version} — Pi ${value.piVersion}`;
  if (command === 'inspect') return JSON.stringify(data, null, 2);
  if (command === 'log') return String(value.text ?? '');
  for (const key of ['transfers', 'sessions', 'hosts', 'topics']) if (Array.isArray(value[key])) return `${key}: ${value[key].length ? '\n' + value[key].map(row => typeof row === 'string' ? row : fields(row)).join('\n') : '(none)'}`;
  return fields(value);
}
function fields(value: Record<string, unknown>): string { return Object.entries(value).filter(([, v]) => v !== undefined).map(([key, v]) => `${key}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'); }
export function progressReporter(quiet = false): NonNullable<OperationContext['progress']> { let last = ''; let at = 0; return (stage, detail) => { if (quiet || (last === stage && Date.now() - at < 250)) return; last = stage; at = Date.now(); process.stderr.write(`${stage}${detail ? ': ' + detail : ''}\n`); }; }
