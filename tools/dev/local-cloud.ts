import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local cloud for tests outside workerd (native devices): serves the test Worker through wrangler dev on a port the system picks, with its
 * state in a fresh temporary directory, prints its URL once wrangler reports it ready, and stops it when stdin closes, which happens when
 * the test process exits however it ends.
 * Out of scope: what the tests check.
 * @see https://developers.cloudflare.com/workers/wrangler/commands/#dev
 */

const root = join(import.meta.dirname, '../..');
const state = mkdtempSync(join(tmpdir(), 'syncline-cloud-'));
const wrangler = spawn(
  join(root, 'node_modules/.bin/wrangler'),
  [
    'dev',
    '--config',
    'src/cloudflare/wrangler.jsonc',
    '--ip',
    '127.0.0.1',
    // Picked by the system when wrangler binds, so no other process can take it in between
    '--port',
    '0',
    '--persist-to',
    state,
    // A fixed debugger port would keep concurrent runs from starting
    '--inspector-port',
    '0',
    // Info level prints the address wrangler serves on
    '--log-level',
    'info',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } },
);
process.stdin.on('end', () => wrangler.kill('SIGINT')).resume();
wrangler.on('exit', (code) => {
  rmSync(state, { recursive: true, force: true });
  process.exit(code ?? 0);
});
const timeout = setTimeout(() => {
  console.error('wrangler dev did not report ready within 30 seconds');
  wrangler.kill('SIGINT');
}, 30_000);
let output: string | undefined = '';
wrangler.stdout.setEncoding('utf8').on('data', (chunk: string) => {
  if (output === undefined) return;
  output += chunk;
  const ready = output.match(/Ready on (http:\/\/\S+)\s/);
  if (!ready) return;
  clearTimeout(timeout);
  console.log(ready[1]);
  output = undefined;
});
