import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import { type Bucket, type BucketRules, bucketId } from '../cloud/buckets.ts';
import { Space } from '../cloud/space.ts';
import type { Chunk, Op, Poke, Reset } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import type { Shared } from './test-device.ts';
import { cloudStorage } from './test-storage.ts';

// 共用空间拉取的测试共用：计划与计划日两张表，公开（已发布的计划、给公开看的计划日）与全部两条桶规则，
// 一块块拉到末块、按顺序应用各块；设备一侧照自己的请求拉到没有暂存的块

export const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });
export const day = sqliteTable('day', {
  id: text().primaryKey(),
  program_id: text().references(() => program.id),
  audience: text().notNull(),
});
export const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY, status TEXT NOT NULL)';
export const schema = [createProgram, 'CREATE TABLE day (id TEXT PRIMARY KEY, program_id TEXT, audience TEXT NOT NULL)'];
export const rules = {
  public: { program: { where: "status = 'published'" }, day: { where: "audience = 'public'" } },
  all: { program: {}, day: {} },
} satisfies BucketRules;

/** 一份订阅：几个桶编成规范写法；指纹就用规范写法本身（测试里不另算哈希，只要不同的订阅不同） */
export function subscribed(...buckets: Bucket[]) {
  const subscription = buckets.map(bucketId).sort();
  return { subscription, sub: JSON.stringify(subscription) };
}

/** 看公开的与看全部的两种设备 */
export const viewer = subscribed(['public']);
export const admin = subscribed(['all']);

/** 共用空间：每满 3 行改到的行一个块边界；一次后台写插一个计划与它的计划日 */
export function catalog() {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [program, day], { shared: { buckets: rules, chunkRows: 3 } });
  const publish = (id: string, status = 'published', audience = 'public') =>
    space.mutate((tx) => {
      tx.insert(program, { id, status });
      tx.insert(day, { id: `${id}-d`, program_id: id, audience });
    });
  return { cloud, space, publish };
}

/**
 * 一块块拉到末块，返回各块；request 是第一个请求，之后带上它的游标与落地的订阅、上一块的 next（照共用空间的设备），一块至多给 limit 个字符的改动
 */
export function pullAll(space: Space, who: ReturnType<typeof subscribed>, request: PullRequest, limit?: number) {
  const chunks: (Poke | Chunk | Reset)[] = [];
  for (let next: PullRequest = request; chunks.length < 50; ) {
    const chunk = space.pullShared(next, who, limit);
    chunks.push(chunk);
    if (!('next' in chunk) || 'cookie' in chunk) return chunks;
    next = { ...request, cursor: chunk.next };
  }
  throw new Error('拉不完');
}

/** 共用空间拉一块：一块至多给 1 个字符的改动，即每块一行（每块至少前进一步） */
export const pullOne = (space: Space, request: PullRequest) => space.pullShared(request, viewer, 1);

/** 设备照自己的请求一块块拉，直到没有暂存的块；serve 决定每个请求拿到什么（默认按公开的订阅每块一行现算），返回发出的请求 */
export async function pullRest(
  catalog: Shared,
  space: Space,
  serve: (request: PullRequest) => Poke | Chunk | Reset = (request) => pullOne(space, request),
) {
  const requests: PullRequest[] = [];
  do {
    const request = catalog.pullRequest();
    requests.push(request);
    expect(await catalog.receive(serve(request))).toBe(true);
  } while (catalog.staging() && requests.length < 20);
  return requests;
}

/** 落在末块那一版的设备接着拉的请求：末块的游标与它按的订阅 */
export function landedRequest(chunks: (Poke | Chunk | Reset)[]): PullRequest {
  const last = chunks.at(-1) as Poke;
  return { cookie: last.cookie, ...(last.landed === undefined ? {} : { landed: last.landed }) };
}

/** 按顺序应用各块得到的表：键是 表名/主键 */
export function contents(chunks: (Poke | Chunk | Reset)[]) {
  const rows = new Map<string, unknown>();
  const remove = (prefix: string) => {
    for (const key of [...rows.keys()]) if (key.startsWith(prefix)) rows.delete(key);
  };
  for (const op of chunks.flatMap((chunk) => (chunk as Chunk).patch as Op[])) {
    if (op.op === 'clear') remove('');
    else if (op.op === 'drop' && !('range' in op) && !op.columns) remove(`${op.table}/`);
    else if (op.op === 'put') rows.set(`${op.table}/${op.row.id}`, op.row);
    else if (op.op === 'del') rows.delete(`${op.table}/${op.key.id}`);
  }
  return [...rows.keys()].sort();
}
