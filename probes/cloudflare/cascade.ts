import { randomUUID } from 'node:crypto';
import { writeRows } from '../../src/common/limits.ts';
import { untilJson, withWorker } from './deploy.ts';
import { connect, next, sleep, tailCalls } from './device.ts';

/**
 * Probes the most CPU-intensive writes within limits on live Cloudflare: deleting a parent row cascading up to the per-write limit (writeRows rows, including cascaded deletes),
 * testing both narrow child tables without additional indexes and wide child tables with 8 indexes and 16 columns of 32 characters each; plus an ~8 MiB insert batch of short wide-table rows (maximum rows, each writing 8 indexes).
 * Deploys worker.ts (via deploy.ts, deleted when finished), pre-populating child rows in a new space via server writes in batches, then pushing this single mutation from a device, considering it executed if confirmed (not held);
 * wrangler tail reports invocation CPU time (including seeding, omitting invocations under 100 ms CPU). DO invocations default to at most 30 s CPU; exceeding this resets the object,
 * causing re-pushes from the device to fail identically and permanently stalling the write. Usage (repo root): node probes/cloudflare/cascade.ts [child_rows], defaults to writeRows - 1
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */

/** Child table: narrow table without additional indexes, or wide table with 8 indexes (worker.ts). */
type Child = 'narrow' | 'wide';

const children = Number(process.argv[2] ?? writeRows - 1);
const seedBatch = 10_000;

/** Pushes one mutation (changes) and waits for confirmation, returning elapsed time or failure reason. */
async function push(url: string, token: string, changes: unknown[]) {
  const socket = await connect(url, token);
  try {
    const text = JSON.stringify([{ client: 'probe', id: 1, changes }]);
    const sentAt = performance.now();
    socket.send(text);
    const reply = await next(socket, 180_000);
    if ('failure' in reply) return reply.failure;
    const confirmed = JSON.parse(reply.message) as { hint?: unknown; lmids?: Record<string, number>; held?: unknown[] };
    const executed = confirmed.hint !== undefined || (confirmed.lmids?.probe === 1 && !confirmed.held?.length);
    return executed
      ? `executed, ${Math.round(performance.now() - sentAt)} ms (${Buffer.byteLength(text)} bytes)`
      : `not executed: ${reply.message.slice(0, 300)}`;
  } finally {
    socket.close();
  }
}

/** Deletes a parent row, cascading to children rows in the child table. */
async function cascade(url: string, secret: string, child: Child) {
  const space = randomUUID();
  for (let from = 0; from < children; from += seedBatch) {
    const count = Math.min(seedBatch, children - from);
    await untilJson(`${url}/seed?${new URLSearchParams({ space, secret, child, from: String(from), count: String(count) })}`);
  }
  const result = await push(url, `${space}.${secret}`, [{ op: 'del', table: 'parent', key: { id: 'p' } }]);
  return `deleted parent row cascading ${children} ${child} rows: ${result}`;
}

/** Inserts an ~8 MiB batch of wide-table rows with short values across 8 indexed columns and remaining columns omitted. */
async function widePut(url: string, secret: string) {
  const row = (n: number) => ({
    op: 'put',
    table: 'wide',
    row: Object.fromEntries([['id', String(n)], ...'abcdefgh'.split('').map((c) => [c, `${c}${n}`])]),
  });
  const rows = Math.min(writeRows, Math.floor((8 * 1024 * 1024) / JSON.stringify(row(1e5)).length));
  const result = await push(
    url,
    `${randomUUID()}.${secret}`,
    Array.from({ length: rows }, (_, n) => row(n)),
  );
  return `inserted ${rows} wide table rows (8 indexes): ${result}`;
}

await withWorker('wrangler.jsonc', async ({ name, secret, url, onCleanUp }) => {
  await tailCalls(name, onCleanUp);
  console.log(await widePut(url, secret));
  for (const child of ['narrow', 'wide'] as const) console.log(await cascade(url, secret, child));
  await sleep(30_000);
});
