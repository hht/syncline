import { randomUUID } from 'node:crypto';
import { withWorker } from './deploy.ts';
import { connect, next, sleep, tailCalls } from './device.ts';

/**
 * Probes the maximum mutation payload size executable on live Cloudflare: Durable Object invocations have a CPU limit (default 30 seconds) and isolate memory limits (128 MB),
 * whereas local workerd enforces neither; exceeding limits resets the object, causing device retries to fail identically. Deploys worker.ts under an ephemeral name using the current wrangler account,
 * testing each payload tier in a fresh space: performs an initial HTTP pull for a cookie, connects via WebSocket, and pushes a mutation of short rows; passing requires receiving a poke or hint (indicating execution),
 * while closed sockets or timeouts fail. wrangler tail reports per-invocation CPU and wall-clock times alongside failure outcomes (e.g., exceededCpu). Deletes the Worker after execution (deploy.ts).
 * Usage (repo root): node probes/cloudflare/push-size.ts [MiB ...], defaults to 1 2 4 6 8
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */

const sizes = process.argv.slice(2).map(Number);

/** Generates a mutation payload targeting approximately bytes, using single short primary-key rows to maximize row and parsed object counts per byte. */
function mutation(bytes: number) {
  const row = (index: number) => ({ op: 'put', table: 't', row: { i: String(index) } });
  const rows = Math.floor(bytes / JSON.stringify(row(1e5)).length);
  return JSON.stringify([{ client: 'probe', id: 1, changes: Array.from({ length: rows }, (_, index) => row(index)) }]);
}

/** Determines whether the subsequent message confirms execution: a poke confirming mutation 1 without holds, or a hint indicating the patch exceeded inline limits after commit. */
function executed(message: string) {
  const reply = JSON.parse(message) as { hint?: unknown; lmids?: Record<string, number>; held?: unknown[] };
  return reply.hint !== undefined || (reply.lmids?.probe === 1 && !reply.held?.length);
}

/** Tests a single size tier, returning elapsed time on success or close code, failure reason, or received message on failure. */
async function attempt(url: string, secret: string, mib: number) {
  const token = `${randomUUID()}.${secret}`;
  let socket: WebSocket;
  try {
    socket = await connect(url, token);
  } catch (error) {
    return `${mib} MiB: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const text = mutation(mib * 1024 * 1024);
    const sentAt = performance.now();
    socket.send(text);
    const reply = await next(socket, 120_000);
    const result =
      'failure' in reply
        ? reply.failure
        : executed(reply.message)
          ? `executed, ${Math.round(performance.now() - sentAt)} ms`
          : `not executed: ${reply.message.slice(0, 300)}`;
    return `${mib} MiB (${Buffer.byteLength(text)} bytes): ${result}`;
  } finally {
    socket.close();
  }
}

await withWorker('wrangler.jsonc', async ({ name, secret, url, onCleanUp }) => {
  await tailCalls(name, onCleanUp);
  for (const mib of sizes.length > 0 ? sizes : [1, 2, 4, 6, 8]) console.log(await attempt(url, secret, mib));
  // Tail log events arrive with slight delay.
  await sleep(30_000);
});
