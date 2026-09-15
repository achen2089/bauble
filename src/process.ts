import type { Registration } from './schema.js';
import { run } from './safe.js';
export function processIdentity(pid = process.pid) { return run('ps', ['-p', String(pid), '-o', 'lstart=']).toString().trim(); }
export function processMatches(reg: Pick<Registration, 'pid' | 'start'>) { try { return processIdentity(reg.pid) === reg.start; } catch { return false; } }
