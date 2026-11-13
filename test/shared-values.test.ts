import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Broadcast } from '../src/cloud/broadcast.ts';
import type { Bucket, Buckets } from '../src/cloud/buckets.ts';
import type { Space } from '../src/cloud/space.ts';
import { parsePullRequest } from '../src/common/pull-url.ts';
import { drain } from './support/test-drive.ts';
import { type CloudEnd, Network } from './support/test-network.ts';
import {
  address,
  both,
  bucketDrafts,
  bucketsOf,
  catchUp,
  changes,
  count,
  covered,
  id,
  install,
  type Model,
  mirrors,
  type Note,
  note,
  noteDraft,
  noteOf,
  open,
  type Pools,
  pools,
  pullOnce,
  serve,
  serverWrite,
  subscribe,
  tag,
  tagDraft,
  tagId,
  tagOf,
} from './support/test-shared-values.ts';
import { Connection } from './support/test-sync.ts';

// Shared spaces with random rows and bucket parameters (escaped, multi-byte, and astral text; integers up to the safe bounds): a device
// ends up holding exactly the rows its subscribed buckets select, with values unchanged, however writes move rows between buckets, pulls
// split into chunks, and its token changes. Expected rows come from filtering the generated rows by each rule's documented meaning.

/** The narrowest bucket holding a note, so a subscription drawn from rows surely selects some; undefined if it is in no parameterized bucket. */
function narrowest({ team, level, count }: Note): Bucket | undefined {
  if (team !== null && level !== null && count !== null && count > 0) return [both, team, level];
  if (team !== null) return ['team', team];
  return level === null ? undefined : ['level', level];
}

test('a device holds exactly the rows its subscribed buckets select, values unchanged, for random rows and bucket parameters', async () => {
  const notes = fc.uniqueArray(fc.tuple(id, noteDraft), { selector: ([key]) => key, maxLength: 10 });
  const tags = fc.array(tagDraft, { maxLength: 6 });
  const sizes = fc.record({ limit: fc.integer({ min: 1, max: 800 }), chunkRows: fc.integer({ min: 1, max: 4 }), countFirst: fc.boolean() });
  await fc.assert(
    fc.asyncProperty(
      pools,
      notes,
      tags,
      fc.tuple(bucketDrafts(0), fc.array(fc.nat({ max: 9 }), { maxLength: 2 })),
      sizes,
      async (pool, noteRows, tagRows, [drafts, picks], { limit, chunkRows, countFirst }) => {
        const { space, buckets } = open(chunkRows);
        const written = noteRows.map(([key, draft]) => noteOf(key, draft, pool));
        const tagged = [...new Map(tagRows.map((draft) => tagOf(draft, pool)).map((row) => [tagId(row), row])).values()];
        // Counting before the write maintains bucket rows on write; counting after reads them from the tables.
        if (countFirst) count(space);
        space.mutate((tx) => {
          for (const row of written) tx.insert(note, row);
          for (const row of tagged) tx.insert(tag, row);
        });
        count(space);
        const drawn = written.filter((_, index) => picks.includes(index)).map(narrowest);
        const list = [...bucketsOf(drafts, pool), ...drawn.filter((bucket) => bucket !== undefined)];
        const phone = install();
        const { responses } = await catchUp(space, phone, await subscribe(buckets, list), limit);
        mirrors(phone, written, tagged, list);
        const total = covered(written, tagged, list);
        for (const response of responses) if ('progress' in response) expect(response.progress?.total).toBe(total);
        phone.device.close();
      },
    ),
    { numRuns: 100 },
  );
});

/** A step: a server write, pulls of a few chunks, a full catch-up, or a token now granting other buckets (`widen` keeps the current ones too). */
const step = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('write' as const), changes }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('pull' as const), chunks: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'catchUp' as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('subscribe' as const), buckets: bucketDrafts(1), widen: fc.boolean() }) },
);
type Step = typeof step extends fc.Arbitrary<infer T> ? T : never;

/** Buckets a changed token grants: the drafted ones, after the current ones when it widens the grant. */
const granted = (list: Bucket[], { buckets, widen }: { buckets: Parameters<typeof bucketsOf>[0]; widen: boolean }, pool: Pools) => [
  ...(widen ? list : []),
  ...bucketsOf(buckets, pool),
];

/** Cloud, model, and one device driven by pull steps; `list` and `who` are the subscription the device's token grants now. */
type Run = Omit<ReturnType<typeof open>, 'storage'> & {
  pool: Pools;
  keys: string[];
  limit: number;
  model: Model;
  phone: ReturnType<typeof install>;
  list: Bucket[];
  who: Awaited<ReturnType<typeof subscribe>>;
};

/** Performs one step; checks the device after each full catch-up. */
async function perform(run: Run, action: Step) {
  const { space, phone, limit, model } = run;
  if (action.kind === 'write') serverWrite(space, action.changes, run.keys, run.pool, model);
  else if (action.kind === 'pull') for (let chunk = 0; chunk < action.chunks; chunk += 1) await pullOnce(space, phone, run.who, limit);
  else if (action.kind === 'catchUp') {
    await catchUp(space, phone, run.who, limit);
    mirrors(phone, model.notes.values(), model.tags.values(), run.list);
  } else {
    run.list = granted(run.list, action, run.pool);
    run.who = await subscribe(run.buckets, run.list);
  }
}

test('server writes moving rows into and out of buckets, interleaved with chunked pulls and subscription changes: devices converge on the selected rows', async () => {
  const ids = fc.uniqueArray(id, { minLength: 1, maxLength: 5 });
  const sizes = fc.record({ limit: fc.integer({ min: 1, max: 600 }), chunkRows: fc.integer({ min: 1, max: 4 }) });
  await fc.assert(
    fc.asyncProperty(pools, ids, bucketDrafts(1), fc.array(step, { maxLength: 14 }), sizes, async (pool, keys, first, steps, sizes) => {
      const { space, buckets } = open(sizes.chunkRows);
      count(space);
      const list = bucketsOf(first, pool);
      const model: Model = { notes: new Map(), tags: new Map() };
      const run: Run = {
        space,
        buckets,
        pool,
        keys,
        limit: sizes.limit,
        model,
        phone: install(),
        list,
        who: await subscribe(buckets, list),
      };
      for (const action of steps) await perform(run, action);
      await catchUp(space, run.phone, run.who, run.limit);
      mirrors(run.phone, model.notes.values(), model.tags.values(), run.list);
      // A device installed now reaches the same rows from a full pull.
      const tablet = install();
      await catchUp(space, tablet, run.who, run.limit);
      mirrors(tablet, model.notes.values(), model.tags.values(), run.list);
      for (const { device } of [run.phone, tablet]) device.close();
    }),
    { numRuns: 100 },
  );
});

/** Production shared space wiring: a broadcast shard and a mock entry Worker serving device-built URLs under the token's subscription. */
async function connect(space: Space, buckets: Buckets, list: Bucket[], limit: number, inline: number) {
  const token = { who: await subscribe(buckets, list) };
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      accept: (socket, url, expiresAt) => broadcast.accept(socket, parsePullRequest(url).cookie, expiresAt, token.who),
      receive: (socket) => broadcast.receive(socket),
      pull: (url) => JSON.stringify(serve(space, url, token.who, limit).response),
    }),
  );
  const broadcast: Broadcast<CloudEnd> = new Broadcast(network.sockets(), async () => space.round(inline));
  const phone = install();
  const connection = new Connection(phone.mirror, { url: address, ...network.options(0) });
  connection.start();
  await drain(network);
  /** Changes the token's grant and reconnects, as an app does when its token changes. */
  const resubscribe = async (next: Bucket[]) => {
    token.who = await subscribe(buckets, next);
    connection.reconnect();
  };
  return { network, broadcast, phone, connection, resubscribe };
}

test('connected devices: live rounds and hinted pulls over device-built URLs keep a device on the selected rows as writes and its token change', async () => {
  const ids = fc.uniqueArray(id, { minLength: 1, maxLength: 4 });
  const live = fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('write' as const), changes }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('token' as const), buckets: bucketDrafts(1), widen: fc.boolean() }) },
  );
  const sizes = fc.record({ limit: fc.integer({ min: 1, max: 600 }), inline: fc.integer({ min: 0, max: 2000 }) });
  const steps = fc.array(fc.tuple(live, fc.boolean()), { maxLength: 8 });
  await fc.assert(
    fc.asyncProperty(pools, ids, bucketDrafts(1), steps, sizes, async (pool, keys, first, actions, { limit, inline }) => {
      const { space, buckets } = open(2);
      count(space);
      const model: Model = { notes: new Map(), tags: new Map() };
      let list = bucketsOf(first, pool);
      const { network, broadcast, phone, connection, resubscribe } = await connect(space, buckets, list, limit, inline);
      for (const [action, settle] of actions) {
        if (action.kind === 'write') {
          const { base } = serverWrite(space, action.changes, keys, pool, model);
          if (base) await broadcast.notify(space.round(inline, base));
        } else {
          list = granted(list, action, pool);
          await resubscribe(list);
        }
        if (settle) await drain(network);
      }
      await drain(network);
      mirrors(phone, model.notes.values(), model.tags.values(), list);
      connection.stop();
      phone.device.close();
    }),
    { numRuns: 100 },
  );
});
