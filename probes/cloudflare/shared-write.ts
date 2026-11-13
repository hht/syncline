import { randomUUID } from 'node:crypto';
import { sharedWriteRows } from '../../src/cloud/limits.ts';
import { account, cloudflare, untilJson, withWorker } from './deploy.ts';

/**
 * Probes the CPU consumption of shared space server writes on live Cloudflare: each modified bucket records 1 to 2 row count updates, peaking when changes distribute across distinct buckets;
 * local workerd does not enforce CPU limits. Deploys shared-worker.ts (via deploy.ts, deleted when finished), waits for initial bucket row counting to settle in a fresh space,
 * and executes three successive writes of rows rows: spread (inserting into distinct new buckets), move (moving rows between distinct buckets), and same (inserting into a single bucket as a baseline).
 * Fetches per-invocation CPU and wall-clock metrics from the GraphQL Analytics API before deleting the Worker, as telemetry is inaccessible post-deletion.
 * wrangler tail omits subrequests to other Durable Objects (such as fanout to broadcast shards).
 * Usage (repo root): node probes/cloudflare/shared-write.ts [rows], defaults to the sharedWriteRows limit
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 * @see https://developers.cloudflare.com/analytics/graphql-api/
 */

const rows = Number(process.argv[2] ?? sharedWriteRows);
const space = randomUUID();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** DO invocation metrics grouped by second, object, and type; CPU and wall-clock times are in microseconds. */
type Invocation = {
  sum: { requests: number };
  dimensions: { datetime: string; namespaceId: string; objectId: string; type: string };
  quantiles: { cpuTimeP999: number; wallTimeP50: number };
};

/**
 * Queries account DO invocations since since using the active wrangler authentication token.
 * Avoids filtering by Worker name because analytics records scriptName as __unknown__ for these calls.
 */
async function invocations(account: string, since: string) {
  const body = await cloudflare('/graphql', {
    query: `query($a: String!, $since: Time!) { viewer { accounts(filter: { accountTag: $a }) {
      durableObjectsInvocationsAdaptiveGroups(limit: 5000, filter: { datetime_geq: $since }, orderBy: [datetime_ASC]) {
        sum { requests } dimensions { datetime namespaceId objectId type } quantiles { cpuTimeP999 wallTimeP50 } } } } }`,
    variables: { a: account, since },
  });
  const data = body.data as { viewer: { accounts: { durableObjectsInvocationsAdaptiveGroups: Invocation[] }[] } } | undefined;
  if (!data) throw new Error(`GraphQL analytics error: ${JSON.stringify(body.errors)}`);
  return data.viewer.accounts[0]?.durableObjectsInvocationsAdaptiveGroups ?? [];
}

/** Matches invocations with at least 100 ms of CPU time. */
const heavy = (group: Invocation) => group.quantiles.cpuTimeP999 >= 100_000;

/**
 * Polls GraphQL analytics once per minute until all three writes appear (up to 20 minutes),
 * absorbing the 7 to 13 minute ingestion delay across broadcast and shared space DO invocations.
 */
async function settled(account: string, since: string) {
  for (let tries = 0; tries < 20; tries += 1) {
    await sleep(60_000);
    const groups = await invocations(account, since);
    console.log(`  analytics: recorded ${groups.reduce((sum, group) => sum + group.sum.requests, 0)} DO invocations`);
    if (groups.filter(heavy).length >= 3) return groups;
  }
  throw new Error('Analytics did not record all three writes within 20 minutes');
}

/** Prints invocations with at least 100 ms CPU time, reporting total invocation count for remaining calls. */
function report(groups: Invocation[]) {
  console.log('DO invocations with >= 100 ms CPU (UTC time, namespace, object, type, CPU, wall clock):');
  for (const { dimensions, sum, quantiles } of groups.filter(heavy))
    console.log(
      `  ${dimensions.datetime.slice(11, 19)} ${dimensions.namespaceId.slice(0, 8)} ${dimensions.objectId.slice(0, 8)} ${dimensions.type}${sum.requests > 1 ? ` ×${sum.requests}` : ''}: CPU ${Math.round(quantiles.cpuTimeP999 / 1000)} ms, wall ${Math.round(quantiles.wallTimeP50 / 1000)} ms`,
    );
  console.log(`Total DO invocations: ${groups.reduce((sum, group) => sum + group.sum.requests, 0)}`);
}

const accountId = account();
const since = new Date().toISOString();
await withWorker('shared-wrangler.jsonc', async ({ secret, url }) => {
  const target = (path: string, query: Record<string, string> = {}) => `${url}${path}?${new URLSearchParams({ space, secret, ...query })}`;
  // Initial space opening schedules bucket row counting via alarm, completing immediately on empty tables.
  for (let waited = 0; !(await untilJson(target('/counted'))); waited += 1) {
    if (waited === 30) throw new Error('Bucket row counting did not finish within 60 seconds');
    await sleep(2000);
  }
  for (const kind of ['spread', 'move', 'same']) {
    const startedAt = performance.now();
    const at = new Date().toISOString().slice(11, 19);
    // Dispatches each write once: CPU limit errors or rejections return error pages, and retrying would re-execute the mutation.
    const response = await fetch(target('/write', { kind, rows: String(rows) }));
    const took = Math.round(performance.now() - startedAt);
    console.log(
      `${at} ${kind} ${rows} rows: ${response.ok ? 'committed and notified' : `error ${response.status}`}, client round-trip ${took} ms`,
    );
    // Spaces writes apart so timestamps remain distinct in analytics.
    await sleep(10_000);
  }
  report(await settled(accountId, since));
});
