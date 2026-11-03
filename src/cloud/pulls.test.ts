import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { valueBytes, valueChars } from '../common/limits.ts';
import { type Cookie, chunkLimit, socketLimit } from '../common/protocol.ts';
import { subscribed } from '../test/test-catalog.ts';
import { cloudStorage, measureReads } from '../test/test-storage.ts';
import type { BucketRules } from './buckets.ts';
import { Space } from './space.ts';

// 云端从库里一次读进内存的量（拉取、拼通知、重扫一张表）：一行、一次提交的主键都可以接近单个值的上限，表可以很大，
// 一次取一百行、一百次提交或整张表的主键会超出 DO 的内存（128 MB），对象被重置，同样的事每次重试都失败。一次读进来的约一块，至多再多一行
// DO 的内存上限 @see https://developers.cloudflare.com/durable-objects/platform/limits/（Memory per isolate）

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
/** 主键列与读字节数时的别名同名 */
const sized = sqliteTable('sized', { bytes: text().primaryKey(), body: text() });

/** 云端的存储，记下一条语句读出来的至多多少字符（read.chars） */
function measuredStorage() {
  const storage = cloudStorage(
    'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)',
    'CREATE TABLE sized (bytes TEXT PRIMARY KEY, body TEXT)',
  );
  const read = measureReads(storage);
  return { storage, read };
}

/** 共用空间的两张表都在一个桶里 */
const everything = subscribed(['all']);
const all = { all: { note: {}, sized: {} } } satisfies BucketRules;

/** 在 measuredStorage 上打开的空间 */
function measured(shared?: { buckets: BucketRules }) {
  const { storage, read } = measuredStorage();
  return { space: new Space(storage, [note, sized], shared && { shared }), read };
}

/** 绕过空间直接插 count 行笔记（主键各约 500 字符），给出主键 */
function insertNotes(storage: ReturnType<typeof measuredStorage>['storage'], count: number) {
  const ids = Array.from({ length: count }, (_, index) => String(index).padStart(5, '0').padEnd(500, 'k'));
  for (const id of ids) storage.sql.exec("INSERT INTO note (id, body) VALUES (?, 'x')", id).toArray();
  return ids;
}

/** 从 cookie 拉完（分块接着拉），给出拉到的行的主键，按先后 */
function pullAll(space: Space, cookie: Cookie | null) {
  let chunk = space.pull({ cookie }, chunkLimit);
  const ops = [...chunk.patch];
  while ('next' in chunk) {
    chunk = space.pull({ cookie, cursor: chunk.next }, chunkLimit);
    ops.push(...chunk.patch);
  }
  return ops.flatMap((op) => (op.op === 'put' ? Object.values(op.key) : []));
}

/** 共用空间（订阅全部的桶）从 first 一块块拉到末块，每块不超过一块加一行；给出拉到的行的主键，按先后 */
function pullSharedAll(space: Space, first: Parameters<Space['pullShared']>[0] = { cookie: null }) {
  const given: unknown[] = [];
  for (let request = first; ; ) {
    const chunk = space.pullShared(request, everything);
    if ('reset' in chunk) throw new Error('不应重置');
    expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(chunkLimit + valueBytes);
    given.push(...chunk.patch.flatMap((op) => (op.op === 'put' ? Object.values(op.key) : [])));
    if ('cookie' in chunk) return given;
    request = { ...first, cursor: chunk.next };
  }
}

/** 第 commit 次提交改到的 1000 行的主键：各约 490 字符（主键至多 512 字节），一次提交的主键约 50 万字符 */
const committed = (commit: number) =>
  keys(1000, (index) => `${String(commit).padStart(2, '0')}-${String(index).padStart(4, '0')}`.padEnd(490, 'k'));

/** 0 到 count - 1 编成主键 */
const keys = (count: number, key: (index: number) => string) => Array.from({ length: count }, (_, index) => key(index));

test('整份拉取：行都接近单个值的上限，一次读进来的不超过一块加一行，每批接着上一批、一行不漏', () => {
  const { space, read } = measured();
  const body = 'x'.repeat(valueChars * 3);
  const ids = keys(20, (index) => `n${String(index).padStart(2, '0')}`);
  for (const id of ids) space.mutate((tx) => tx.insert(note, { id, body }));
  read.chars = 0;
  expect(pullAll(space, null)).toEqual(ids);
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('增量拉取：每次提交改到很多行，一次读进来的提交记录不超过一块加一次提交，按提交先后、一行不漏', () => {
  const { space, read } = measured();
  const cookie = space.head();
  const commits = Array.from({ length: 20 }, (_, commit) => committed(commit));
  for (const ids of commits)
    space.mutate((tx) => {
      for (const id of ids) tx.insert(note, { id });
    });
  const ids = commits.flat();
  read.chars = 0;
  expect(pullAll(space, cookie)).toEqual(ids);
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('整份拉取：主键列叫 bytes，照样按主键算字节数', () => {
  const { space, read } = measured();
  // 按主键排，大行在前；按字节数排会把小行排在前面、算少了要取的字节数
  for (const [index, chars] of [valueChars * 3, valueChars * 3, valueChars * 3, 1, 1, 1].entries())
    space.mutate((tx) => tx.insert(sized, { bytes: `k${index}`, body: 'x'.repeat(chars) }));
  read.chars = 0;
  expect(pullAll(space, null)).toEqual(keys(6, (index) => `k${index}`));
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('推送后拼通知：一批写每条都改到很多行，一次读进来的提交记录不超过一块加一次提交', () => {
  const { space, read } = measured();
  const mutations = Array.from({ length: 20 }, (_, commit) => ({
    client: 'c1',
    id: commit + 1,
    changes: committed(commit).map((id) => ({ op: 'put' as const, table: 'note', row: { id } })),
  }));
  read.chars = 0;
  expect(space.push(mutations, socketLimit)).not.toHaveProperty('patch');
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('共用空间给落下很久的分片拼一轮：其间每次提交都改到很多行，一次读进来的不超过一块加一次提交', () => {
  const { space, read } = measured({ buckets: all });
  const base = space.head();
  for (let commit = 0; commit < 20; commit += 1) {
    const ids = committed(commit);
    space.mutate((tx) => {
      for (const id of ids) tx.insert(note, { id });
    });
  }
  read.chars = 0;
  expect(space.round(socketLimit, base)).not.toHaveProperty('rows');
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('共用空间拼一轮跨过几批提交记录：给全、按先后', () => {
  const { space } = measured({ buckets: all });
  const base = space.head();
  const ids = keys(150, (index) => `n${String(index).padStart(3, '0')}`);
  for (const id of ids) space.mutate((tx) => tx.insert(note, { id }));
  const { rows } = space.round(chunkLimit, base);
  expect(rows?.map((row) => row.key.id)).toEqual(ids);
});

test('打开空间时进入同步的表很大：打开时不读这张表（只在范围表记下从哪一版起），设备拉到它时按主键分批读，一次读进来的不超过一块；设备照增量收到每一行', () => {
  const { storage, read } = measuredStorage();
  const before = new Space(storage, [sized]).head();
  const ids = insertNotes(storage, 3000);
  read.chars = 0;
  const space = new Space(storage, [note, sized]);
  expect(read.chars).toBeLessThan(1000);
  expect(pullAll(space, before)).toEqual(ids);
  expect(read.chars).toBeLessThanOrEqual(chunkLimit);
});

test('共用空间部署改了桶规则、很多行在不在桶里变了：打开时不读这张表（只在范围表记下从哪一版起）', () => {
  const { storage, read } = measuredStorage();
  new Space(storage, [note, sized], { shared: { buckets: all } });
  insertNotes(storage, 3000);
  read.chars = 0;
  new Space(storage, [note, sized], { shared: { buckets: { all: { note: { where: "body = 'y'" }, sized: {} } } } });
  expect(read.chars).toBeLessThan(1000);
});

test('重扫一张表时主键都接近单个值的上限：按字节分批读，一次读进来的不超过一块加一个主键', () => {
  const { storage, read } = measuredStorage();
  const before = new Space(storage, [sized]).head();
  const ids = Array.from({ length: 8 }, (_, index) => `${index}`.padEnd(valueChars - 10, 'k'));
  for (const id of ids) storage.sql.exec('INSERT INTO note (id) VALUES (?)', id).toArray();
  const space = new Space(storage, [note, sized]);
  read.chars = 0;
  expect(pullAll(space, before)).toEqual(ids);
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('共用空间整份扫描、行都接近单个值的上限：一块按字符数封顶，一块不超过一块加一行；拉完给全、按主键', () => {
  // 每 10 行一个块边界：20 行写完正好落在边界上，首次整份从它扫起、之后没有增量，只看扫描怎么切
  const { storage } = measuredStorage();
  const space = new Space(storage, [note, sized], { shared: { buckets: all, chunkRows: 10 } });
  const body = 'x'.repeat(valueChars * 3);
  const ids = keys(20, (index) => `n${String(index).padStart(2, '0')}`);
  for (const id of ids) space.mutate((tx) => tx.insert(note, { id, body }));
  expect(pullSharedAll(space)).toEqual(ids);
});

test('共用空间增量、改到的行都接近单个值的上限：一块按字符数封顶（可以切在一次提交中间），一块不超过一块加一行；拉完给全', () => {
  const { space } = measured({ buckets: all });
  const body = 'x'.repeat(valueChars * 3);
  // 一次后台写 20 行（一版）：从空的空间落地的地方起，全由增量给
  const ids = keys(20, (index) => `n${String(index).padStart(2, '0')}`);
  const first = space.pullShared({ cookie: null }, everything);
  if (!('cookie' in first)) throw new Error('空的共用空间一块给完');
  space.mutate((tx) => {
    for (const id of ids) tx.insert(note, { id, body });
  });
  expect(pullSharedAll(space, { cookie: first.cookie, ...(first.landed === undefined ? {} : { landed: first.landed }) })).toEqual(ids);
});

test('没接校验和（核心的 Space，功能由入口接上）：请求带 checksum 也不回校验和，末块照常', () => {
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)'), [note]);
  space.mutate((tx) => tx.insert(note, { id: 'n1' }));
  const chunk = space.pull({ cookie: null, checksum: '' }, chunkLimit);
  expect(chunk).toHaveProperty('cookie');
  expect(chunk).not.toHaveProperty('checksum');
});
