import { getTableConfig, primaryKey, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, test } from 'vitest';
import { keyBytes, subscriptionBytes } from '../common/limits.ts';
import type { Chunk, Poke, Reset } from '../common/protocol.ts';
import { pullURL } from '../common/pull-url.ts';
import { subscribed } from '../test/test-catalog.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { bucketBytes } from './buckets.ts';
import { encodePosition } from './position.ts';
import { Space } from './space.ts';

// 拉取的游标（cursor）：部署改了同步的表时在拉的游标接着扫，设备带来伪造或损坏的游标时不抛错；私有与共用两种空间同一个形状

const table = (name: string) => sqliteTable(name, { id: text().primaryKey(), n: text().notNull() });
const a = table('a');
const b = table('b');
const c = table('c');
const pair = sqliteTable('pair', { x: text().notNull(), y: text().notNull(), n: text().notNull() }, (t) => [
  primaryKey({ columns: [t.x, t.y] }),
]);
const schema = [
  'CREATE TABLE a (id TEXT PRIMARY KEY, n TEXT NOT NULL)',
  'CREATE TABLE b (id TEXT PRIMARY KEY, n TEXT NOT NULL)',
  'CREATE TABLE c (id TEXT PRIMARY KEY, n TEXT NOT NULL)',
  'CREATE TABLE pair (x TEXT NOT NULL, y TEXT NOT NULL, n TEXT NOT NULL, PRIMARY KEY (x, y))',
];

type Puller = (space: Space, cursor: string | undefined) => Poke | Chunk | Reset;
const privatePull: Puller = (space, cursor) => space.pull({ cookie: null, ...(cursor === undefined ? {} : { cursor }) }, 1);
const everything = subscribed(['v']);
const sharedPull: Puller = (space, cursor) =>
  space.pullShared({ cookie: null, ...(cursor === undefined ? {} : { cursor }) }, everything, 1);
/** 共用空间：同步的表都在一个桶里；每次写都是块边界，整份的水位就是最新一版，尾巴不重给扫过的行 */
const sharedOptions = (tables: SQLiteTable[]) => ({
  shared: { buckets: { v: Object.fromEntries(tables.map((table) => [getTableConfig(table).name, {}])) }, chunkRows: 1 },
});
const kinds = [
  { name: '私有', pull: privatePull, options: () => undefined },
  { name: '共用', pull: sharedPull, options: sharedOptions },
] as const;

/** 往 a、b 各写 6 行，一块块拉；扫到 midway 表时部署（同一个库、新的表单）；给出一路上的清空次数、重复给的行数与是否部署过 */
function pulledAcrossDeploy(kind: (typeof kinds)[number], after: (typeof a)[], midway: string) {
  const storage = cloudStorage(...schema);
  let space = new Space(storage, [a, b], kind.options([a, b]));
  space.mutate((tx) => {
    for (let i = 0; i < 6; i += 1) {
      tx.insert(a, { id: `a${i}`, n: 'x' });
      tx.insert(b, { id: `b${i}`, n: 'x' });
    }
  }, 0);
  const puts: string[] = [];
  let clears = 0;
  let deployed = false;
  let cursor: string | undefined;
  for (let step = 0; step < 100; step += 1) {
    const chunk = kind.pull(space, cursor);
    if ('reset' in chunk) throw new Error('不应重置');
    clears += chunk.patch.filter((op) => op.op === 'clear').length;
    puts.push(...chunk.patch.flatMap((op) => (op.op === 'put' ? [`${op.table}/${op.row.id}`] : [])));
    if ('cookie' in chunk) break;
    cursor = chunk.next;
    const scanning = (JSON.parse(chunk.next) as { scan?: { table: string } }).scan?.table;
    if (!deployed && scanning === midway && puts.length >= 3) {
      deployed = true;
      space = new Space(storage, after, kind.options(after));
    }
  }
  return { clears, duplicates: puts.length - new Set(puts).size, puts: puts.length, deployed };
}

describe('部署改了同步的表，在拉的游标接着扫', () => {
  const deploys = [
    { label: '末尾加一张表 c', after: [a, b, c], midway: 'b' },
    { label: '改了先后 [b, a]', after: [b, a], midway: 'b' },
    { label: '扫 a 时去掉还没扫的 b', after: [a], midway: 'a' },
  ];
  // 读取器按表名的全序扫，部署后接着扫
  for (const kind of kinds)
    for (const { label, after, midway } of deploys)
      test(`${kind.name}空间 ${label}：游标接着扫，只清空一次（第一块的）、不重复给行`, () => {
        const { clears, duplicates, puts, deployed } = pulledAcrossDeploy(kind, after, midway);
        expect(deployed).toBe(true);
        expect({ clears, duplicates }, `清空 ${clears} 次，重复给了 ${duplicates} 行（共给 ${puts} 个 put）`).toEqual({
          clears: 1,
          duplicates: 0,
        });
      });
});

/** 拉到第一块有 scan.after 的块，再让空间有了新的提交（别的设备或后台写的），给出这个游标 */
function scanning(kind: (typeof kinds)[number]) {
  const space = new Space(cloudStorage(...schema), [a, b, pair], kind.options([a, b, pair]));
  space.mutate((tx) => {
    for (let i = 0; i < 4; i += 1) {
      tx.insert(a, { id: `a${i}`, n: 'x' });
      tx.insert(pair, { x: `x${i}`, y: `y${i}`, n: 'x' });
    }
  }, 0);
  let cursor: string | undefined;
  for (let step = 0; step < 50; step += 1) {
    const chunk = kind.pull(space, cursor);
    if (!('next' in chunk) || 'cookie' in chunk) break;
    cursor = chunk.next;
    if ((JSON.parse(cursor) as { scan?: { after?: unknown } }).scan?.after) {
      space.mutate((tx) => tx.upsert(a, { id: 'a0', n: 'changed' }), 0);
      return { space, real: JSON.parse(cursor) as Record<string, unknown> & { scan: Record<string, unknown> } };
    }
  }
  throw new Error('没拉到扫描中途的游标');
}

/** 读取器的位置：照它的每个字段伪造 */
function forgedFields(space: Space, real: Record<string, unknown> & { scan: Record<string, unknown> }) {
  type At = { version: number; nonce: number };
  const { round, tail } = real as unknown as { round: { from: unknown; to: At }; tail: { at: At } };
  const future = { version: 9999, nonce: 1 };
  return {
    full不是布尔: { ...real, full: 'yes' },
    水位是未来版本: { ...real, round: { ...round, to: future } },
    水位的随机数不对: { ...real, round: { ...round, to: { ...round.to, nonce: round.to.nonce + 1 } } },
    本轮起点是未来版本: { ...real, round: { ...round, from: future } },
    尾巴是未来版本: { ...real, tail: { at: future } },
    尾巴的随机数不对: { ...real, tail: { at: { ...tail.at, nonce: tail.at.nonce + 1 } } },
    尾巴的index超出: { ...real, tail: { ...tail, index: 1e9 } },
    尾巴的index是负数: { ...real, tail: { ...tail, index: -1 } },
    尾巴的index配最新一版: { ...real, tail: { at: space.head(), index: 3 } },
    seen是未来版本: { ...real, seen: future },
    表名不存在: { ...real, scan: { ...real.scan, table: 'nope' } },
    原型上的表名: { ...real, scan: { ...real.scan, table: '__proto__' } },
    主键形状不对_缺列: { ...real, scan: { table: 'pair', after: { x: 'x1' } } },
    主键形状不对_多余列: { ...real, scan: { ...real.scan, after: { id: 'a1', zzz: 1 } } },
    主键值是null: { ...real, scan: { ...real.scan, after: { id: null } } },
    带的进度乱写: { ...real, carried: { downloaded: 'x', total: -1 } },
    重下的范围不是数组: { ...real, ranges: { table: 'a' } },
    重下的范围缺表名: { ...real, ranges: [{ after: { id: 'a1' } }] },
    重下的范围缺主键的列: { ...real, ranges: [{ table: 'pair', after: { x: 'x1' } }] },
    重下的范围的值不对: { ...real, ranges: [{ table: 'a', until: { id: [1] } }] },
    不同步的表带着重下的起止: { ...real, ranges: [{ table: 'nope', after: { id: 'a1' } }] },
  };
}

describe('伪造或损坏的游标不抛错（抛错在 DO 里就是 500）', () => {
  for (const kind of kinds) {
    test(`${kind.name}空间：各种伪造的游标都不抛错`, () => {
      const { space, real } = scanning(kind);
      const fields = forgedFields(space, real);
      const forged: Record<string, string> = {
        非JSON: 'not json',
        空对象: '{}',
        数组: '[]',
        ...Object.fromEntries(Object.entries(fields).map(([label, value]) => [label, JSON.stringify(value)])),
      };
      for (const [label, cursor] of Object.entries(forged)) expect(() => kind.pull(space, cursor), label).not.toThrow();
    });
  }
});

test('共用空间拉取的网址最长（订阅 8 KB、接着拉的位置里桶与主键都最长且全是要转义的字符、带下限与这一代）：不超过 Cloudflare 的 16 KB', () => {
  // 落地时的订阅编成 base64url：subscriptionBytes 字节的 4/3
  const landed = 'x'.repeat(Math.ceil(subscriptionBytes / 3) * 4);
  // 主键编成 JSON 正好 keyBytes 字节、桶正好 bucketBytes 字节，全是引号（JSON 里转义成两个字符，网址里再转义成 %5C%22）
  const id = '"'.repeat((keyBytes - JSON.stringify({ id: '' }).length) / 2);
  expect(JSON.stringify({ id }).length).toBeLessThanOrEqual(keyBytes);
  const bucket = '"'.repeat(bucketBytes / 2);
  const most = Number.MAX_SAFE_INTEGER;
  const cookie = { version: most, nonce: most };
  const cursor = encodePosition({
    full: true,
    round: { from: cookie, to: cookie },
    scan: { table: 't'.repeat(64), bucket, after: { id } },
    sub: 's'.repeat(64),
    added: true,
    tail: { at: cookie, index: most },
    carried: { downloaded: most, total: most },
  });
  const url = pullURL('https://sync.example.com/catalog', { cookie, cursor, landed, atLeast: most, incarnation: most });
  expect(url.length).toBeLessThan(16 * 1024);
});
