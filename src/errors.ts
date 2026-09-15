import type { NextAction } from './output.js';
export type ErrorCategory = 'usage' | 'config' | 'capability' | 'target' | 'approval' | 'busy' | 'uncertain';
export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly category: ErrorCategory, readonly hint: string | null = null, readonly data: object | null = null, readonly nextActions: NextAction[] = []) { super(message); }
  get exitCode() { return this.category === 'usage' ? 2 : this.category === 'approval' ? 3 : this.category === 'uncertain' ? 4 : 1; }
}
/** Retain upgrade guidance without erasing authority uncertainty already on disk. */
export function withStreamCapability(cause: unknown, failure: CliError): CliError {
  if (!(cause instanceof CliError) || cause.code !== 'STREAM_CAPABILITY') return failure;
  return new CliError(failure.code, `${failure.message} This connection rejected before operation admission; earlier capture or authority cannot be ruled out.`, failure.category, [cause.hint, failure.hint].filter(Boolean).join(' '), { ...failure.data, cause: { code: cause.code, message: cause.message, hint: cause.hint } }, failure.nextActions);
}
export function usageError(message: string): never { throw new CliError('USAGE', message, 'usage', 'Use bauble help <command>.'); }
