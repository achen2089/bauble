// Real subprocess framing seam, never SSH/native inference.
import { appendFileSync, writeFileSync } from 'node:fs';
import { frames, serveStream, streamHello, writeFrame, MAX_FRAME } from '../src/stream.js';
const mode = process.argv[2] ?? 'echo';
if (mode === 'echo' || mode === 'lost-response') {
  await serveStream(process.stdin, process.stdout, async request => {
    if (mode === 'lost-response') {
      writeFileSync(process.argv[3]!, 'admitted');
      await new Promise(ok => setTimeout(ok, 150));
      appendFileSync(process.argv[3]!, ':finished');
    }
    if (request.operation === 'revoke') throw new Error('SECRET payload');
    return request.data;
  });
} else {
  let count = 0;
  for await (const _raw of frames(process.stdin)) {
    if (count++ === 0) {
      if (mode === 'incompatible') { await writeFrame(process.stdout, { ...streamHello(), version: '0.1.0' }); continue; }
      if (mode === 'no-handshake') continue;
      await writeFrame(process.stdout, streamHello()); continue;
    }
    if (mode === 'incompatible' && process.argv[3]) appendFileSync(process.argv[3], 'unexpected operation\n');
    if (mode === 'timeout') continue;
    if (mode === 'lost-ack') process.exit(0);
    if (mode === 'malformed') process.stdout.write('{not json}\n');
    if (mode === 'utf8') process.stdout.write(Buffer.from([0xc0, 0xaf, 10]));
    if (mode === 'oversized') process.stdout.write('x'.repeat(MAX_FRAME + 1) + '\n');
    if (mode === 'wrong-id') await writeFrame(process.stdout, { type: 'response', id: 999, ok: true, data: {} });
    if (mode === 'duplicate') process.stdout.write(JSON.stringify({ type: 'response', id: 1, ok: true, data: {} }) + '\n' + JSON.stringify({ type: 'response', id: 1, ok: true, data: {} }) + '\n');
  }
}
