import fc from 'fast-check';
import { expect, test } from 'vitest';
import type { Bucket } from '../src/cloud/buckets.ts';
import { failure, rows } from './support/test-roundtrip.ts';
import { both, catchUp, install, mirrors, type Note, note, open, shortText, subscribe, tag, whole } from './support/test-shared-values.ts';
import { char } from './support/test-values.ts';

// Shared space limits with random values: the entrypoint and server writes accept or refuse a bucket alike, so no accepted row sits in a
// bucket no device may subscribe to, and an accepted subscription pulls fully and incrementally through URLs the platform accepts.
// Expected outcomes come from the documented byte limits measured on the canonical JSON names.

const utf8 = (text: string) => new TextEncoder().encode(text).length;
/** Documented bucket limit: a canonical bucket name (JSON) of at most 256 UTF-8 bytes. */
const fits = (bucket: Bucket) => utf8(JSON.stringify(bucket)) <= 256;
/** Cloudflare refuses request URLs over 16 KB. @see https://developers.cloudflare.com/workers/platform/limits/#request-limits */
const urlBytes = 16 * 1024;
const longest = (urls: string[]) => Math.max(...urls.map(utf8));

/** Team text whose bucket lands within a few bytes of the 256-byte limit: a random head padded with one repeated character. */
const nearBucketLimit = fc.record({ head: shortText, pad: char, delta: fc.integer({ min: -3, max: 3 }) }).map(({ head, pad, delta }) => {
  const room = 256 - utf8(JSON.stringify(['team', head]));
  return head + pad.repeat(Math.max(0, Math.floor(room / (utf8(JSON.stringify(pad)) - 2)) + delta));
});

test('buckets around the 256-byte limit: the entrypoint and server writes accept or refuse alike, and an accepted row reaches a subscribed device', async () => {
  await fc.assert(
    fc.asyncProperty(nearBucketLimit, fc.option(whole), fc.option(whole), async (team, level, count) => {
      const { storage, space, buckets } = open(1000);
      const row: Note = { id: 'r', team, level, label: null, count, ratio: null };
      const held: Bucket[] = [['team', team], ...(level === null ? [] : [['level', level] as Bucket])];
      if (level !== null && count !== null && count > 0) held.push([both, team, level]);
      const entry = await failure(() => buckets.subscribe([['team', team]]));
      expect(entry === undefined, entry).toBe(fits(['team', team]));
      const write = await failure(() =>
        space.mutate((tx) => {
          tx.insert(note, row);
          tx.insert(tag, { team, n: 1, label: null });
        }),
      );
      expect(write === undefined, write).toBe(held.every(fits));
      if (write !== undefined) {
        expect([rows(storage, note), rows(storage, tag)]).toEqual([[], []]);
        return;
      }
      for (const bucket of held) {
        const phone = install();
        await catchUp(space, phone, await subscribe(buckets, [bucket]), 200);
        mirrors(phone, [row], [{ team, n: 1, label: null }], [bucket]);
        phone.device.close();
      }
    }),
    { numRuns: 60 },
  );
});

/** Size of a subscription as the limit measures it: the JSON array of canonical bucket names, in UTF-8 bytes. */
const subscriptionSize = (names: Iterable<string>) => utf8(JSON.stringify([...names]));

/** Team buckets whose subscription JSON lands within two bytes of the 8,192-byte limit: random long buckets, then fillers to the target. */
const nearSubscriptionLimit = fc
  .record({
    heads: fc.array(fc.tuple(shortText, fc.integer({ min: 130, max: 180 })), { minLength: 60, maxLength: 60 }),
    delta: fc.integer({ min: -2, max: 2 }),
  })
  .map(({ heads, delta }) => {
    const target = 8192 + delta;
    const names = new Set<string>();
    for (const [head, pad] of heads) {
      const name = JSON.stringify(['team', head + 'x'.repeat(pad)]);
      // Each name adds its JSON string and a comma.
      if (subscriptionSize(names) + utf8(JSON.stringify(name)) + 1 <= target - 300) names.add(name);
    }
    // A filler name `["team","yyy"]` adds 17 bytes plus its length as a JSON string, and one more for its comma.
    const room = target - subscriptionSize(names) - 1;
    const fillers = room - 17 > 245 ? [Math.floor((room - 1) / 2), Math.ceil((room - 1) / 2)] : [room];
    for (const [index, filler] of fillers.entries()) names.add(JSON.stringify(['team', (index === 0 ? 'y' : 'z').repeat(filler - 17)]));
    return [...names].map((name) => JSON.parse(name) as Bucket);
  });

test('subscriptions around the 8,192-byte limit: the entrypoint refuses exactly those over it, and an accepted one pulls fully and incrementally through URLs', async () => {
  await fc.assert(
    fc.asyncProperty(nearSubscriptionLimit, fc.integer({ min: 200, max: 4000 }), async (list, limit) => {
      const { space, buckets } = open(1000);
      const entry = await failure(() => buckets.subscribe(list));
      expect(entry === undefined, entry).toBe(subscriptionSize(list.map((bucket) => JSON.stringify(bucket))) <= 8192);
      if (entry !== undefined) return;
      const notes = list.map(([, team], index): Note => ({ ...blank, id: String(index), team: team as string }));
      space.mutate((tx) => {
        for (const row of notes) tx.insert(note, row);
      });
      const who = await subscribe(buckets, list);
      const phone = install();
      const full = await catchUp(space, phone, who, limit);
      mirrors(phone, notes, [], list);
      const late: Note = { ...blank, id: 'late', team: list[0]?.[1] as string };
      space.mutate((tx) => tx.insert(note, late));
      const incremental = await catchUp(space, phone, who, limit);
      mirrors(phone, [...notes, late], [], list);
      // Adding a row after landing pulls only the change: the landed subscription decoded from the URL still matches.
      const ops = incremental.responses.flatMap((response) => ('patch' in response ? response.patch : []));
      expect(ops.map(({ op }) => op)).toEqual(['put']);
      expect(longest([...full.urls, ...incremental.urls])).toBeLessThanOrEqual(urlBytes);
      phone.device.close();
    }),
    { numRuns: 15 },
  );
});

const blank = { level: null, label: null, count: null, ratio: null };

test('the longest pull URL stays within the platform limit: largest subscription landed, scanning a 256-byte bucket of quotes after a 512-byte key of quotes', async () => {
  const { space, buckets } = open(1000);
  const quotes: Bucket = ['team', `${'"'.repeat(122)}a`];
  const filler = (index: number): Bucket => ['team', `${String(index).padStart(3, '0')}${'x'.repeat(200)}`];
  const list: Bucket[] = [quotes];
  while (subscriptionSize([...list, filler(list.length)].map((bucket) => JSON.stringify(bucket))) <= 8192) list.push(filler(list.length));
  expect(utf8(JSON.stringify(quotes))).toBe(256);
  const keys = [`${'"'.repeat(250)}a`, `${'"'.repeat(251)}a`];
  expect(keys.map((key) => utf8(JSON.stringify({ id: key })))).toEqual([510, 512]);
  space.mutate((tx) => {
    for (const key of keys) tx.insert(note, { id: key, team: quotes[1] as string });
  });
  const phone = install();
  const urls: string[] = [];
  // Dropping a bucket forces a full pull that carries the landed subscription while scanning the quoted bucket; adding the quoted
  // bucket back after landing without it scans only that bucket, again beside a near-limit landed subscription.
  const quoted = keys.map((key): Note => ({ ...blank, id: key, team: quotes[1] as string }));
  for (const subscribed of [list, list.slice(0, -1), list.slice(1), list]) {
    urls.push(...(await catchUp(space, phone, await subscribe(buckets, subscribed), 1)).urls);
    mirrors(phone, quoted, [], subscribed);
  }
  expect(longest(urls)).toBeLessThanOrEqual(urlBytes);
  phone.device.close();
});
