import { join, resolve } from 'node:path';
import type { Manifest } from './schema.js';
import { invariant } from './safe.js';
export function targetRepository(manifest: Manifest, root: string, codeRoot?: string) {
  if (manifest.codeRoot) { invariant(codeRoot && resolve(codeRoot) === manifest.codeRoot, 'Configured codeRoot changed or is not authorized'); return join(manifest.codeRoot, `${manifest.name ? manifest.name + '-' : ''}${manifest.transferId}`); }
  return join(resolve(root), 'runs', manifest.transferId, 'workspace', 'worktree');
}
