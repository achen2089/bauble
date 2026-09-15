import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Digest } from './schema.js';
import { atomicWrite, hash, invariant, privateDir, readBytes } from './safe.js';
export class Blobs {
  constructor(readonly root: string) { privateDir(root); }
  path(digest: string) { return join(this.root, Digest.parse(digest)); }
  put(bytes: Buffer | string) { const data = Buffer.from(bytes); const digest = hash(data); const path = this.path(digest); if (existsSync(path)) invariant(hash(readBytes(path)) === digest, `Corrupt blob ${digest}`); else atomicWrite(path, data); return digest; }
  get(digest: string) { const data = readBytes(this.path(digest)); invariant(hash(data) === digest, `Corrupt blob ${digest}`); return data; }
  has(digest: string) { if (!existsSync(this.path(digest))) return false; this.get(digest); return true; }
}
