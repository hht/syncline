import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import fc from 'fast-check';
import { expect } from 'vitest';
import { type Bucket, type BucketRules, Buckets, subscriptionHash } from '../../src/cloud/buckets.ts';
import { canonicalPosition } from '../../src/cloud/position.ts';
import type { Subscribed } from '../../src/cloud/shared.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Transaction } from '../../src/cloud/transaction.ts';
import type { Chunk, Poke, Reset } from '../../src/protocol/messages.ts';
import { parsePullRequest, pullURL } from '../../src/protocol/pull-url.ts';
import { defineTables } from '../../src/tables/table-definitions.ts';
import { Device } from './test-device.ts';
import { rows } from './test-roundtrip.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';
import { char, sorted } from './test-values.ts';

// Shared space fixtures for value property tests: tables with text and integer bucket columns, rules (one named with both quote kinds),
// the oracle (which rows a bucket holds, by each rule's documented meaning), generators drawing bucket parameters from small pools so
// subscriptions select some rows and miss others, and pulls that travel as URLs rebuilt the way the entry Worker forwards them.

export const note = sqliteTable('note', {
  id: text().primaryKey(),
  team: text(),
  level: integer(),
  label: text(),
  count: integer(),
  ratio: real(),
});
export const tag = sqliteTable('tag', { team: text().notNull(), n: integer().notNull(), label: text() }, (table) => [
  primaryKey({ columns: [table.team, table.n] }),
]);
const tables = [note, tag];
const deviceSchema = [
  'CREATE TABLE note (id TEXT PRIMARY KEY, team TEXT, level INTEGER, label TEXT, count INTEGER, ratio REAL)',
  'CREATE TABLE tag (team TEXT NOT NULL, n INTEGER NOT NULL, label TEXT, PRIMARY KEY (team, n))',
];

export type Note = typeof note.$inferSelect;
type Tag = typeof tag.$inferSelect;

/** A rule name holding both quote kinds, so rule names pass through SQL literals and JSON escaping. */
export const both = `it's "both"`;
const rules = {
  team: { note: { by: ['team'] }, tag: { by: ['team'] } },
  level: { note: { by: ['level'] } },
  [both]: { note: { where: 'count > 0', by: ['team', 'level'] } },
  labelled: { note: { where: 'label IS NOT NULL' }, tag: { where: 'label IS NOT NULL' } },
} satisfies BucketRules;

/** Whether a bucket holds a row, by the documented meaning: the row passes the rule's `where` and its `by` columns equal the parameters. */
function holds([rule, ...params]: Bucket, row: Note | Tag): boolean {
  if (rule === 'team') return row.team === params[0];
  if (rule === 'labelled') return row.label !== null;
  if (!('id' in row)) return false;
  if (rule === 'level') return row.level === params[0];
  return rule === both && row.count !== null && row.count > 0 && row.team === params[0] && row.level === params[1];
}

/** Rows that a subscription selects, sorted as {@link rows} reads them. */
const selected = <T extends Note | Tag>(all: Iterable<T>, buckets: Bucket[]) =>
  sorted([...all].filter((row) => buckets.some((bucket) => holds(bucket, row))));

/** Bucket rows a subscription covers, counting a row once per bucket holding it (the documented download progress total). */
export function covered(notes: Note[], tags: Tag[], buckets: Bucket[]) {
  const unique = [...new Set(buckets.map((bucket) => JSON.stringify(bucket)))].map((id) => JSON.parse(id) as Bucket);
  return unique.reduce((total, bucket) => total + [...notes, ...tags].filter((row) => holds(bucket, row)).length, 0);
}

/** Shared space created as the Durable Object creates it: tables and bucket indexes first, then the space. */
export function open(chunkRows: number) {
  const storage = cloudStorage();
  const buckets = new Buckets(tables, rules);
  defineTables(storage, tables, tables, (table) => buckets.indexes(table));
  const space = new Space(storage, tables, { shared: { buckets: rules, chunkRows } });
  return { storage, space, buckets };
}

/** Counts bucket rows to completion, as background maintenance does. */
export function count(space: Space) {
  while (space.bucketRows?.step());
}

/** Subscription as the entrypoint computes it from the buckets `verify` returns. */
export async function subscribe(buckets: Buckets, list: Bucket[]): Promise<Subscribed> {
  const subscription = buckets.subscribe(list);
  return { subscription, sub: await subscriptionHash(subscription) };
}

export const address = 'https://sync.test/catalog';

/** Serves a pull URL as production does: the entry Worker rebuilds it with the canonical cursor, and the space parses the rebuilt URL. */
export function serve(space: Space, sent: URL, who: Subscribed, limit: number) {
  const pull = parsePullRequest(sent);
  const cursor = pull.cursor === undefined ? {} : { cursor: canonicalPosition(pull.cursor) ?? pull.cursor };
  const forwarded = new URL(pullURL(`${sent.origin}${sent.pathname}`, { ...pull, ...cursor }));
  return { response: space.pullShared(parsePullRequest(forwarded), who, limit), urls: [sent.href, forwarded.href] };
}

/** A device opening the shared space. */
export function install() {
  const storage = deviceStorage(...deviceSchema);
  const device = new Device(storage, []);
  return { storage, device, mirror: device.shared('catalog', tables) };
}
type Installed = ReturnType<typeof install>;

/** Pulls one chunk into the device over a URL; returns the response and the URLs sent. */
export async function pullOnce(space: Space, { mirror }: Installed, who: Subscribed, limit: number) {
  const { response, urls } = serve(space, new URL(pullURL(address, mirror.pullRequest())), who, limit);
  expect(await mirror.receive(response)).toBe(true);
  return { response, urls };
}

/** Pulls until the device lands the cloud head under the current subscription; returns every response and URL. */
export async function catchUp(space: Space, installed: Installed, who: Subscribed, limit: number) {
  const responses: (Poke | Chunk | Reset)[] = [];
  const urls: string[] = [];
  for (let pulls = 0; pulls < 2000; pulls += 1) {
    const { response, urls: sent } = await pullOnce(space, installed, who, limit);
    responses.push(response);
    urls.push(...sent);
    const landed = 'cookie' in response && response.sub === who.sub && response.cookie.version === space.head().version;
    if (landed && !installed.mirror.staging()) return { responses, urls };
  }
  throw new Error('device did not catch up');
}

/** Asserts the device holds exactly the rows of both tables that the buckets select. */
export function mirrors({ storage }: Installed, notes: Iterable<Note>, tags: Iterable<Tag>, buckets: Bucket[]) {
  expect(rows(storage, note)).toEqual(selected(notes, buckets));
  expect(rows(storage, tag)).toEqual(selected(tags, buckets));
}

/** Any character, weighted towards JSON-escaped, boundary, and astral ones, and towards those URL queries reserve or escape. */
const textChar = fc.oneof(
  { weight: 4, arbitrary: char },
  { weight: 1, arbitrary: fc.constantFrom('&', '+', '#', '%', '=', '?', '/', ' ', "'", '~', '%2B') },
);
/** Short text of any characters. */
export const shortText = fc.string({ unit: textChar, maxLength: 10 });
/** Integers: small values rows share, the safe bounds, 32-bit edges, and any safe integer. */
export const whole = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: -2, max: 2 }) },
  { weight: 1, arbitrary: fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 31, -(2 ** 31) - 1, 2 ** 32) },
  { weight: 1, arbitrary: fc.maxSafeInteger() },
);
const label = fc.option(
  fc.oneof({ weight: 6, arbitrary: shortText }, { weight: 1, arbitrary: fc.string({ unit: textChar, maxLength: 300 }) }),
);
/** Primary key text: short strings of any characters. */
export const id = fc.string({ unit: textChar, maxLength: 8 });

/** Bucket parameter pools rows and subscriptions draw from, so subscriptions select some rows and miss others. */
export const pools = fc.record({
  teams: fc.uniqueArray(shortText, { minLength: 1, maxLength: 4 }),
  levels: fc.uniqueArray(whole, { minLength: 1, maxLength: 3 }),
});
export type Pools = { teams: string[]; levels: number[] };
const at = <T>(pool: T[], index: number) => pool[index % pool.length] as T;
const pick = <T>(pool: T[], index: number | null) => (index === null ? null : at(pool, index));

/** Note columns with bucket columns as pool indexes. */
export const noteDraft = fc.record({
  team: fc.option(fc.nat()),
  level: fc.option(fc.nat()),
  label,
  count: fc.option(whole),
  ratio: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true })),
});
type NoteDraft = { team: number | null; level: number | null; label: string | null; count: number | null; ratio: number | null };
/** Note row as the cloud stores it and Drizzle reads it back (SQLite has no negative zero). */
export const noteOf = (key: string, draft: NoteDraft, { teams, levels }: Pools): Note => ({
  id: key,
  team: pick(teams, draft.team),
  level: draft.level === null ? null : at(levels, draft.level) + 0,
  label: draft.label,
  count: draft.count === null ? null : draft.count + 0,
  ratio: draft.ratio === null ? null : draft.ratio + 0,
});

export const tagDraft = fc.record({ team: fc.nat(), n: whole, label });
export const tagOf = (draft: { team: number; n: number; label: string | null }, { teams }: Pools): Tag => ({
  team: at(teams, draft.team),
  n: draft.n + 0,
  label: draft.label,
});
export const tagId = ({ team, n }: Tag) => JSON.stringify([team, n]);

/** Subscribed bucket with parameters as pool indexes; `stray` buckets take a parameter outside the pool, or one in it when both spellings are. */
const bucketDraft = fc.record({
  rule: fc.oneof(
    { weight: 3, arbitrary: fc.constant('team') },
    { weight: 2, arbitrary: fc.constantFrom('level', 'both') },
    { weight: 1, arbitrary: fc.constantFrom('labelled', 'stray') },
  ),
  a: fc.nat(),
  b: fc.nat(),
  stray: shortText,
});
/** Subscriptions of one to four buckets, as pool indexes. */
export const bucketDrafts = (minLength: number) => fc.array(bucketDraft, { minLength, maxLength: 4 });
type BucketDraft = { rule: string; a: number; b: number; stray: string };
/** Resolves subscribed bucket drafts against the pools. */
export const bucketsOf = (drafts: BucketDraft[], { teams, levels }: Pools) =>
  drafts.map(({ rule, a, b, stray }): Bucket => {
    if (rule === 'team') return ['team', at(teams, a)];
    if (rule === 'level') return ['level', at(levels, a)];
    if (rule === 'both') return [both, at(teams, a), at(levels, b)];
    if (rule === 'labelled') return ['labelled'];
    return teams.includes(`${stray}~`) ? ['team', stray] : ['team', `${stray}~`];
  });

/** One change in a server write: puts a whole note, moves a note across buckets, deletes a note, or puts or deletes a tag; ids are pool indexes. */
const change = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('put' as const), id: fc.nat(), note: noteDraft }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('move' as const), id: fc.nat(), team: fc.option(fc.nat()), level: fc.option(fc.nat()) }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('delete' as const), id: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('tag' as const), tag: tagDraft, keep: fc.boolean() }) },
);
/** Server writes of one to three changes. */
export const changes = fc.array(change, { minLength: 1, maxLength: 3 });
type Change = typeof change extends fc.Arbitrary<infer T> ? T : never;

/** Rows the cloud holds, by primary key. */
export type Model = { notes: Map<string, Note>; tags: Map<string, Tag> };

/** Applies a change to the transaction and to the model alike; `keys` resolves note ids. */
function enact(tx: Transaction, item: Change, keys: string[], pool: Pools, { notes, tags }: Model) {
  if (item.kind === 'tag') {
    const row = tagOf(item.tag, pool);
    if (item.keep) tx.upsert(tag, row);
    else tx.delete(tag, { team: row.team, n: row.n });
    if (item.keep) tags.set(tagId(row), row);
    else tags.delete(tagId(row));
    return;
  }
  const key = at(keys, item.id);
  const row = notes.get(key);
  if (item.kind === 'put') {
    tx.upsert(note, noteOf(key, item.note, pool));
    notes.set(key, noteOf(key, item.note, pool));
  } else if (item.kind === 'move') {
    const moved = { id: key, team: pick(pool.teams, item.team), level: pick(pool.levels, item.level) };
    tx.update(note, moved);
    if (row) notes.set(key, { ...row, ...moved });
  } else {
    tx.delete(note, { id: key });
    notes.delete(key);
  }
}

/** Runs one server write of the changes, applying each to the model as the documented {@link Space.mutate} transaction calls do. */
export function serverWrite(space: Space, list: Change[], keys: string[], pool: Pools, model: Model) {
  return space.mutate((tx) => {
    for (const item of list) enact(tx, item, keys, pool, model);
  });
}
