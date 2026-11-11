import { randomBytes, randomUUID } from 'node:crypto';
import { type Chunk, type Cookie, type Mutation, type Poke, pushMutations } from '../../src/common/protocol.ts';
import { pullURL } from '../../src/common/pull-url.ts';
import { account, cloudflare, withWorker } from './deploy.ts';
import { connect, next, sleep } from './device.ts';

/**
 * Probes how long a pending backlog takes to upload on live Cloudflare for each push batch size, pushing one batch at a time as devices do:
 * a batch takes mutations while the change bytes before each one stay under the limit (at least one, at most pushMutations), and the next batch
 * goes out once the cloud confirms the previous one, by poke on the WebSocket or, when the confirmation exceeds the socket limit, by hint followed
 * by an HTTP pull started at once, as a private space does.
 * Tiers, each twice: 1 MB and 100 KB of ~270-byte writes (one row each) in fixed 12 KB batches, in batches starting at 12 KB and doubling up to
 * 128 KB as devices send them, and (1 MB only) in fixed 128 KB batches.
 * Row bodies are random base64 so gzip on HTTP pulls does not compress them unrealistically. Each tier uses a fresh space.
 * Reads Durable Object usage for this Worker's namespace from the GraphQL Analytics API before deleting it, as telemetry is inaccessible after deletion.
 * Usage (repo root): node probes/cloudflare/push-batch.ts
 * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
 * @see https://developers.cloudflare.com/analytics/graphql-api/
 */

const body = (bytes: number) =>
  randomBytes(Math.ceil((bytes * 3) / 4))
    .toString('base64')
    .slice(0, bytes);
const writes = (count: number): Mutation[] =>
  Array.from({ length: count }, (_, write) => ({
    client: 'probe',
    id: write + 1,
    changes: [{ op: 'put' as const, table: 'note', row: { id: String(write), body: body(210) } }],
  }));

/** Size limit of the batch at index sent on a connection. */
type Sizing = { name: string; limit: (index: number) => number };
const sizings: Sizing[] = [
  { name: 'fixed 12 KB', limit: () => 12_000 },
  { name: '12 KB doubling to 128 KB', limit: (index) => Math.min(12_000 * 2 ** index, 128_000) },
  { name: 'fixed 128 KB', limit: () => 128_000 },
];
type Tier = { name: string; limit: (index: number) => number; mutations: () => Mutation[] };
const backlogs = [
  { name: '1 MB', writes: 4000, sizings },
  { name: '100 KB', writes: 400, sizings: sizings.slice(0, 2) },
];
const tiers: Tier[] = [1, 2].flatMap((run) =>
  backlogs.flatMap((backlog) =>
    backlog.sizings.map(({ name, limit }) => ({
      name: `${backlog.name} of small rows, ${name}, run ${run}`,
      limit,
      mutations: () => writes(backlog.writes),
    })),
  ),
);

const bytesOf = ({ changes }: Mutation) => Buffer.byteLength(JSON.stringify(changes));

/** Leading batch of pending mutations, as the device lists it. */
function batch(pending: Mutation[], limit: number) {
  const taken: Mutation[] = [];
  let before = 0;
  for (const mutation of pending.slice(0, pushMutations)) {
    if (before >= limit) break;
    taken.push(taken.length === 0 ? { ...mutation, first: true } : mutation);
    before += bytesOf(mutation);
  }
  return taken;
}

/** HTTP pull from cookie to head, as the device does after a hint, returning the final chunk. */
async function pullFrom(url: string, token: string, cookie: Cookie | null) {
  let cursor: string | undefined;
  for (;;) {
    const response = await fetch(pullURL(url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie, clients: ['probe'], ...(cursor !== undefined && { cursor }) }),
    });
    if (!response.ok) throw new Error(`pull failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    const result = (await response.json()) as Poke | Chunk;
    if ('cookie' in result) return result;
    cursor = result.next;
  }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** Median WebSocket round trip of 10 pings answered by the runtime. */
async function rtt(socket: WebSocket) {
  const times: number[] = [];
  for (let n = 0; n < 10; n += 1) {
    const at = performance.now();
    socket.send('ping');
    const reply = await next(socket, 30_000);
    if ('failure' in reply) throw new Error(reply.failure);
    times.push(performance.now() - at);
  }
  return median(times);
}

type Device = { url: string; token: string; socket: WebSocket; cookie: Cookie };
type Sent = { ms: number; hint: boolean; pullMs: number };

/** Sends one batch and waits until the cloud confirms any of it, by poke or by hint and HTTP pull; returns the highest confirmed id. */
async function upload(device: Device, sent: Mutation[], confirmed: number, timing: Sent[]) {
  const at = performance.now();
  device.socket.send(JSON.stringify(sent));
  const time: Sent = { ms: 0, hint: false, pullMs: 0 };
  let highest = confirmed;
  while (highest === confirmed) {
    const reply = await next(device.socket, 600_000);
    if ('failure' in reply) throw new Error(reply.failure);
    if (reply.message === 'pong') continue;
    const message = JSON.parse(reply.message) as Partial<Poke> & { hint?: Cookie };
    let poke: Partial<Poke> = message;
    if (message.hint) {
      time.hint = true;
      const pulledAt = performance.now();
      poke = await pullFrom(device.url, device.token, device.cookie);
      time.pullMs += performance.now() - pulledAt;
    }
    if (poke.cookie) device.cookie = poke.cookie;
    highest = Math.max(highest, poke.lmids?.probe ?? 0);
  }
  timing.push({ ...time, ms: performance.now() - at });
  return highest;
}

async function run(url: string, secret: string, tier: Tier) {
  const token = `${randomUUID()}.${secret}`;
  const socket = await connect(url, token);
  try {
    const ping = await rtt(socket);
    const all = tier.mutations();
    const total = all.reduce((sum, mutation) => sum + bytesOf(mutation), 0);
    // The space is fresh, so this pull is one small chunk: the device likewise holds a cookie on history before pushing
    const device = { url, token, socket, cookie: (await pullFrom(url, token, null)).cookie };
    const timing: Sent[] = [];
    const startedAt = performance.now();
    for (let confirmed = 0; confirmed < all.length; )
      confirmed = await upload(device, batch(all.slice(confirmed), tier.limit(timing.length)), confirmed, timing);
    const took = performance.now() - startedAt;
    const hints = timing.filter(({ hint }) => hint);
    console.log(
      `${tier.name}: ${Math.round(total / 1000)} KB in ${timing.length} batches, ${(took / 1000).toFixed(1)} s` +
        ` (${Math.round(total / took)} KB/s); ping RTT ${Math.round(ping)} ms; batch median ${Math.round(median(timing.map(({ ms }) => ms)))} ms;` +
        ` ${hints.length} confirmed by hint + HTTP pull (pull median ${Math.round(median(hints.map(({ pullMs }) => pullMs)))} ms)`,
    );
  } finally {
    socket.close();
  }
}

type Usage = { rowsWritten: number; rowsRead: number; activeTime: number; requests: number; objects: number };

/**
 * Durable Object usage of one namespace since since: storage rows and active time (microseconds) from periodic groups, requests from invocations.
 * Periodic groups are filtered from the start of since's hour, as their datetime is the hour, and return rows only when grouped by a dimension;
 * grouping by object counts the objects recorded so far.
 */
async function usage(accountId: string, namespace: string, since: string): Promise<Usage> {
  const hour = `${since.slice(0, 13)}:00:00Z`;
  const body = await cloudflare('/graphql', {
    query: `query($a: String!, $n: String!, $since: Time!, $hour: Time!) { viewer { accounts(filter: { accountTag: $a }) {
      durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $hour, namespaceId: $n }) { sum { rowsWritten rowsRead activeTime } dimensions { objectId } }
      durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $since, namespaceId: $n }) { sum { requests } dimensions { type } } } } }`,
    variables: { a: accountId, n: namespace, since, hour },
  });
  type Groups = {
    durableObjectsPeriodicGroups: { sum: Omit<Usage, 'requests' | 'objects'>; dimensions: { objectId: string } }[];
    durableObjectsInvocationsAdaptiveGroups: { sum: { requests: number } }[];
  };
  const groups = (body.data as { viewer: { accounts: Groups[] } } | undefined)?.viewer.accounts[0];
  if (!groups) throw new Error(`GraphQL analytics error: ${JSON.stringify(body.errors)}`);
  const total = (key: keyof Omit<Usage, 'requests' | 'objects'>) =>
    groups.durableObjectsPeriodicGroups.reduce((sum, { sum: s }) => sum + s[key], 0);
  return {
    rowsWritten: total('rowsWritten'),
    rowsRead: total('rowsRead'),
    activeTime: total('activeTime'),
    requests: groups.durableObjectsInvocationsAdaptiveGroups.reduce((sum, { sum: s }) => sum + s.requests, 0),
    objects: new Set(groups.durableObjectsPeriodicGroups.map(({ dimensions }) => dimensions.objectId)).size,
  };
}

/**
 * Polls usage once per minute until every tier's object is recorded and two readings match, up to an hour: ingestion took from 7 to over
 * 25 minutes, and readings can repeat while objects are still missing.
 */
async function settled(accountId: string, namespace: string, since: string) {
  let last: Usage | undefined;
  for (let tries = 0; tries < 60; tries += 1) {
    await sleep(60_000);
    const now = await usage(accountId, namespace, since);
    console.log(`  analytics: ${JSON.stringify(now)}`);
    if (now.objects >= tiers.length && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
  }
  return last;
}

const accountId = account();
const since = new Date().toISOString();
await withWorker('wrangler.jsonc', async ({ name, secret, url }) => {
  // Usage is read even when a tier fails, as the Worker and its analytics go once this returns
  const failed = await (async () => {
    for (const tier of tiers) await run(url, secret, tier);
  })().catch((error: unknown) => error);
  const namespaces = (await cloudflare(`/accounts/${accountId}/workers/durable_objects/namespaces`)).result as {
    id: string;
    script: string;
  }[];
  const namespace = namespaces.find(({ script }) => script === name);
  if (!namespace) throw new Error(`No Durable Object namespace found for ${name}`);
  const used = await settled(accountId, namespace.id, since);
  if (used)
    console.log(
      `Usage of ${used.objects} objects: ${used.requests} DO requests, ${used.rowsWritten} rows written, ${used.rowsRead} rows read, ${(used.activeTime / 1e6).toFixed(0)} s active`,
    );
  if (failed) throw failed;
});
