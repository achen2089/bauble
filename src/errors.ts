import type { NextAction } from './output.js';
export type ErrorCategory = 'usage' | 'config' | 'capability' | 'target' | 'approval' | 'busy' | 'uncertain';
export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly category: ErrorCategory, readonly hint: string | null = null, readonly data: object | null = null, readonly nextActions: NextAction[] = []) { super(message); }
  get exitCode() { return this.category === 'usage' ? 2 : this.category === 'approval' ? 3 : this.category === 'uncertain' ? 4 : 1; }
}
export function usageError(message: string): never { throw new CliError('USAGE', message, 'usage', 'Use bauble help <command>.'); }
