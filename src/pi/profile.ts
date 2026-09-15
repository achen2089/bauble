import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { Profile, type Native } from '../schema.js';
import { Blobs } from '../blobs.js';
import { hash, invariant, json, listFiles, privateDir, readBytes, readJson, run, safePath, validatePaths } from '../safe.js';
import { forbidden } from '../workspace.js';

export function readProfile(path: string) { return readJson(path, Profile); }
export function snapshotProfile(profile: Profile, base: string, blobs: Blobs) {
  const resources: Native['resources'] = [];
  for (const kind of ['instructions', 'skills', 'prompts'] as const) for (const [order, input] of profile[kind].entries()) {
    const path = resolve(base, input); invariant(!forbidden(path), `Forbidden profile resource: ${path}`);
    const st = lstatSync(path); invariant(!st.isSymbolicLink(), `Symlink profile resource: ${path}`);
    // Skills are declared as complete directories. Instructions/templates may be files or directories.
    invariant(kind !== 'skills' || st.isDirectory(), 'Declare each skill as its complete directory');
    const files = st.isDirectory() ? listFiles(path) : [basename(path)]; validatePaths(files);
    invariant(files.length > 0, `Empty resource: ${path}`);
    for (const file of files) { invariant(!forbidden(file), `Forbidden resource file: ${file}`); const full = st.isDirectory() ? join(path, file) : path; resources.push({ kind, order, path: safePath(file), hash: blobs.put(readBytes(full)), executable: Boolean(lstatSync(full).mode & 0o111) }); }
  }
  return { resources, digest: profileDigest(profile, resources) };
}
export function profileDigest(profile: Profile, resources: Native['resources']) {
  return hash(json({ ...profile, instructions: profile.instructions.map((_, i) => `instructions/${i}`), skills: profile.skills.map((_, i) => `skills/${i}`), prompts: profile.prompts.map((_, i) => `prompts/${i}`), resources }));
}
export function materializeProfile(profile: Profile, resources: Native['resources'], blobs: Blobs, root: string): Profile {
  invariant(!existsSync(root), `Profile snapshot already exists: ${root}`); privateDir(root);
  validatePaths(resources.map(r => `${r.kind}/${r.order}/${r.path}`));
  for (const r of resources) { const path = join(root, r.kind, String(r.order), r.path); privateDir(dirname(path)); writeFileSync(path, blobs.get(r.hash), { flag: 'wx', mode: r.executable ? 0o700 : 0o600 }); }
  const result = structuredClone(profile);
  for (const kind of ['instructions', 'skills', 'prompts'] as const) result[kind] = profile[kind].map((_, i) => join(root, kind, String(i)));
  return result;
}
export async function checkRequirements(profile: Profile) {
  for (const executable of profile.executables) run('which', [executable]);
  for (const service of profile.services) await new Promise<void>((ok, fail) => { const socket = connect(service.port, service.host); socket.setTimeout(3000); socket.once('connect', () => { socket.destroy(); ok(); }); socket.once('error', fail); socket.once('timeout', () => { socket.destroy(); fail(new Error(`Required service unavailable: ${service.name}`)); }); });
}
