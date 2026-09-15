// Isolated SSH argv seam; never connects to a host or opens a user session.
import { VERSION, PI_VERSION } from '../src/metadata.js';
import { readFileSync } from 'node:fs';
import { Request, readMessage } from '../src/transport.js';
import { handleRequest } from '../src/protocol.js';
import { Config } from '../src/schema.js';
import { json } from '../src/safe.js';
const request = Request.parse(await readMessage(process.stdin));
process.env.BAUBLE_CONFIG = process.env.BAUBLE_TEST_REMOTE_CONFIG!;
const config = Config.parse(JSON.parse(readFileSync(process.env.BAUBLE_CONFIG, 'utf8')));
try {
  const data = request.operation === 'probe' ? { protocol: 1, version: VERSION, piVersion: PI_VERSION, root: process.env.BAUBLE_TEST_REMOTE_ROOT, codeRoot: config.codeRoot, profileDigest: process.env.BAUBLE_TEST_PROFILE_DIGEST } : await handleRequest(request, { config, allowFixture: true });
  process.stdout.write(json({ ok: true, data }));
} catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
