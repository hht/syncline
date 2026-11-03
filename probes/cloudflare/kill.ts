import { randomUUID } from 'node:crypto';
import { withWorker } from './deploy.ts';
import { connect, next, pull, sleep, tailCalls } from './device.ts';

/**
 * Probes whether writes executed in the same turn are committed when a Durable Object is terminated by the platform for exceeding CPU time: pushed mutations execute sequentially in individual savepoints,
 * while the implicit transaction commits only after yielding the turn (see Space.push). Deploys worker.ts (via deploy.ts, deleted when finished), pushing a batch in a new space:
 * mutation 1 writes row 'a', and mutation 2 writes row 'b' and row 'spin' (which spins during validation until the platform terminates DO execution with exceededCpu). A full pull inspects surviving rows on the cloud:
 * neither row indicates full batch rollback; only 'a' indicates earlier writes committed before termination (writes preceding held or failed mutations are confirmed, avoiding re-pushes and maintaining consistency);
 * 'b' indicates partial mutation commit (corrupting state). wrangler tail reports invocation outcomes (expected: exceededCpu).
 * Usage (repo root): node probes/cloudflare/kill.ts [runs], defaults to 3
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */

const times = Number(process.argv[2] ?? 3);

/** Batch with two mutations: a; b and spin. */
const batch = JSON.stringify([
  { client: 'probe', id: 1, changes: [{ op: 'put', table: 't', row: { i: 'a' } }] },
  {
    client: 'probe',
    id: 2,
    changes: [
      { op: 'put', table: 't', row: { i: 'b' } },
      { op: 'put', table: 't', row: { i: 'spin' } },
    ],
  },
]);

/** Pushes a batch, awaits termination, and performs a full pull to report socket outcome and surviving cloud rows. */
async function attempt(url: string, secret: string) {
  const token = `${randomUUID()}.${secret}`;
  const socket = await connect(url, token);
  const sentAt = performance.now();
  socket.send(batch);
  const reply = await next(socket, 120_000);
  socket.close();
  const outcome = 'failure' in reply ? reply.failure : `received ${reply.message.slice(0, 200)}`;
  // Requests immediately following an object reset may hit restarts.
  await sleep(5000);
  const pulled = await pull(url, token);
  const rows = pulled.patch.filter(({ op }) => op === 'put').map((op) => ('row' in op ? (op.row as { i: string }).i : ''));
  return `${Math.round((performance.now() - sentAt) / 1000)}s later ${outcome}; cloud rows: ${JSON.stringify(rows.sort())}`;
}

await withWorker('wrangler.jsonc', async ({ name, secret, url, onCleanUp }) => {
  await tailCalls(name, onCleanUp);
  for (let time = 1; time <= times; time += 1) console.log(`run ${time}: ${await attempt(url, secret)}`);
  await sleep(30_000);
});
