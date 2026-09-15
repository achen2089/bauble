import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { fixtureRoot, fixtureProfile, fixtureRepo, fixtureSession } from './fixtures.js';
import { Store } from '../src/store.js';
import { materializeProfile, snapshotProfile } from '../src/pi/profile.js';
import { createManaged } from '../src/pi/runtime.js';
import { runtimeSignature } from '../src/pi/native.js';
import { atomicWrite, json } from '../src/safe.js';
import { Profile } from '../src/schema.js';

test('profile snapshots full declared directories/modes and native prompt inputs survive resource relocation', async () => {
  const root = fixtureRoot(); const fixture = fixtureProfile(root); const repo = fixtureRepo(root); const store = new Store(join(root, 'state'));
  const skills = join(root, 'example-skill'); mkdirSync(skills); writeFileSync(join(skills, 'SKILL.md'), '---\nname: example-skill\ndescription: Fixture skill\n---\nUse helper.sh.\n'); writeFileSync(join(skills, 'helper.sh'), '#!/bin/sh\nprintf helper\n'); chmodSync(join(skills, 'helper.sh'), 0o755);
  const instruction = join(root, 'INSTRUCTIONS.md'); writeFileSync(instruction, 'Keep all native context.\n');
  const profile = { ...fixture.profile, instructions: [instruction], skills: [skills] }; atomicWrite(fixture.path, json(profile));
  const snapshot = snapshotProfile(profile, root, store.blobs); assert.equal(snapshot.resources.length, 3);
  const relocated = materializeProfile(profile, snapshot.resources, store.blobs, join(root, 'relocated'));
  assert.ok(statSync(join(relocated.skills[0]!, 'helper.sh')).mode & 0o111);
  assert.equal(snapshotProfile(relocated, root, store.blobs).digest, snapshot.digest);
  const otherPath = join(root, 'relocated-profile.json'); atomicWrite(otherPath, json(relocated));
  const first = await createManaged({ store, profilePath: fixture.path, cwd: repo, manager: fixtureSession(repo, root).manager, allowTest: true });
  const signature = runtimeSignature(first.runtime.session, snapshot.digest); await first.close();
  const other = await createManaged({ store: new Store(join(root, 'other-state')), profilePath: otherPath, cwd: repo, manager: fixtureSession(repo, join(root, 'other')).manager, allowTest: true });
  assert.equal(runtimeSignature(other.runtime.session, snapshot.digest), signature); await other.close();
  assert.throws(() => Profile.parse({ ...profile, extensions: ['unknown-executable.ts'] }));
  rmSync(root, { recursive: true, force: true });
});
