import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateCodeRoot } from './hosts.js';
import { Store } from './store.js';
import { atomicWrite, hash, invariant, json, privateDir, readBytes, syncTree, validatePaths } from './safe.js';
import { validateCheckpoint } from './checkpoint.js';
import { restoreWorkspace, inventory } from './workspace.js';
import { materializeProfile, readProfile, snapshotProfile } from './pi/profile.js';

/** Only materializes approved inputs. SessionManager.create runs once, inside the claimed destination runtime. */
export function prepareFresh(store: Store, id: string) {
  return store.lock(id, () => {
    const manifest = validateCheckpoint(store, id); const { digest } = store.manifest(id); invariant(manifest.native.session === null, 'Not a fresh task');
    const root = join(store.root, 'runs', id); const receipt = join(root, 'fresh-prepared.json'); const profilePath = join(root, 'profile.json');
    const expected = { id, digest, cwd: manifest.target.cwd, profilePath };
    if (manifest.codeRoot) validateCodeRoot(manifest.codeRoot, store.root);
    if (existsSync(receipt)) {
      invariant(readBytes(receipt).toString() === json(expected), 'Fresh preparation binding changed');
      invariant(snapshotProfile(readProfile(profilePath), root, store.blobs).digest === manifest.native.profileDigest, 'Fresh profile changed');
      const actual = inventory(manifest.target.repository, store.blobs, manifest.workspace.sensitiveApproved);
      invariant(actual.head === manifest.workspace.head && json(actual.index) === json(manifest.workspace.index) && json(actual.files) === json(manifest.workspace.files), 'Prepared workspace changed');
      for (const input of manifest.inputs ?? []) invariant(hash(readBytes(join(root, 'inputs', input.path))) === input.hash, 'Prepared task/context changed');
      return expected;
    }
    invariant(!existsSync(root), 'Partial fresh preparation; manual inspection required, never rebuild/restart');
    if (manifest.codeRoot) invariant(!existsSync(manifest.target.repository), 'Fresh code directory already exists');
    privateDir(root);
    restoreWorkspace(manifest.workspace, store.blobs, join(root, 'workspace'), manifest.target.repository);
    invariant(existsSync(manifest.target.cwd), 'Selected cwd missing from inventory (empty directories are not preserved)');
    const profile = materializeProfile(manifest.native.profile, manifest.native.resources, store.blobs, join(root, 'resources')); atomicWrite(profilePath, json(profile));
    validatePaths((manifest.inputs ?? []).map(input => input.path));
    for (const input of manifest.inputs ?? []) atomicWrite(join(root, 'inputs', input.path), store.blobs.get(input.hash));
    syncTree(root); if (manifest.codeRoot) syncTree(manifest.target.repository);
    atomicWrite(receipt, json(expected)); return expected;
  });
}
