import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local cloud for tests outside workerd (native devices): serves the test Worker through wrangler dev on a free port with its state in
 * a fresh temporary directory, prints its URL once it answers, and stops it when stdin closes, which happens when the test process exits
 * however it ends.
 * Out of scope: what the tests check.
 * @see https://developers.cloudflare.com/workers/wrangler/commands/#dev
 */

const root = join(import.meta.dirname, '../..');
const state = mkdtempSync(join(tmpdir(), 'syncline-cloud-'));
const port = await new Promise<number>((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});
const wrangler = spawn(
  join(root, 'node_modules/.bin/wrangler'),
  [
    'dev',
    '--config',
    'src/cloudflare/wrangler.jsonc',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--persist-to',
    state,
    // A fixed debugger port would keep concurrent runs from starting
    '--inspector-port',
    '0',
    '--log-level',
    'warn',
  ],
  { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
);
process.stdin.on('end', () => wrangler.kill('SIGINT')).resume();
wrangler.on('exit', (code) => {
  rmSync(state, { recursive: true, force: true });
  process.exit(code ?? 0);
});
const url = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    await fetch(url);
    console.log(url);
    break;
  } catch {
    if (Date.now() > deadline) {
      console.error(`wrangler dev did not answer on ${url} within 30 seconds`);
      wrangler.kill('SIGINT');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
