// Isolated SSH argv seam; never connects to a host or opens a user session.
import { VERSION, PI_VERSION } from '../src/metadata.js';
import { readFileSync, appendFileSync } from 'node:fs';
import { Request, readMessage } from '../src/transport.js';
import { serveStream } from '../src/stream.js';
import { handleRequest } from '../src/protocol.js';
import { Config } from '../src/schema.js';
import { json } from '../src/safe.js';
process.env.BAUBLE_CONFIG = process.env.BAUBLE_TEST_REMOTE_CONFIG!;
if (process.env.BAUBLE_TEST_HELPER_COUNT) appendFileSync(process.env.BAUBLE_TEST_HELPER_COUNT, 'helper\n');
const handle = async (request: Request) => {
  const config = Config.parse(JSON.parse(readFileSync(process.env.BAUBLE_CONFIG!, 'utf8')));
  return request.operation === 'probe' ? { protocol: 1, version: VERSION, piVersion: PI_VERSION, root: process.env.BAUBLE_TEST_REMOTE_ROOT, codeRoot: config.codeRoot, profileDigest: process.env.BAUBLE_TEST_PROFILE_DIGEST } : handleRequest(request, { config, allowFixture: true });
};
try {
  if (process.argv.includes('bauble _helper-stream')) await serveStream(process.stdin, process.stdout, handle);
  else process.stdout.write(json({ ok: true, data: await handle(Request.parse(await readMessage(process.stdin))) }));
} catch { process.stderr.write('Fixture helper failed'); process.exitCode = 1; }
