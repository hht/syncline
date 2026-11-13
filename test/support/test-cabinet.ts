import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import { type Bucket, type BucketRules, bucketId } from '../../src/cloud/buckets.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Chunk, Op, Poke, Reset } from '../../src/protocol/messages.ts';
import type { PullRequest } from '../../src/protocol/pull-url.ts';
import type { Shared } from './test-device.ts';
import { cloudStorage } from './test-storage.ts';

// Shared space pull test fixtures: project and doc tables, public (published projects and public docs) and all bucket rules.
// Pulls chunks sequentially to final chunk; device pulls following its own requests until no staged chunks remain.

export const project = sqliteTable('project', { id: text().primaryKey(), status: text().notNull() });
export const doc = sqliteTable('doc', {
  id: text().primaryKey(),
  project_id: text().references(() => project.id),
  exposure: text().notNull(),
});
export const createProject = 'CREATE TABLE project (id TEXT PRIMARY KEY, status TEXT NOT NULL)';
export const schema = [createProject, 'CREATE TABLE doc (id TEXT PRIMARY KEY, project_id TEXT, exposure TEXT NOT NULL)'];
export const rules = {
  public: { project: { where: "status = 'published'" }, doc: { where: "exposure = 'public'" } },
  all: { project: {}, doc: {} },
} satisfies BucketRules;

/** Creates a subscription descriptor: canonicalizes buckets; uses JSON representation as digest fingerprint in tests. */
export function subscribed(...buckets: Bucket[]) {
  const subscription = buckets.map(bucketId).sort();
  return { subscription, sub: JSON.stringify(subscription) };
}

/** Viewers subscribing to public bucket, and admins subscribing to all. */
export const viewer = subscribed(['public']);
export const admin = subscribed(['all']);

/** Shared space: chunk boundary every 3 changed rows; helper inserts a project and its doc. */
export function cabinet() {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [project, doc], { shared: { buckets: rules, chunkRows: 3 } });
  const publish = (id: string, status = 'published', exposure = 'public') =>
    space.mutate((tx) => {
      tx.insert(project, { id, status });
      tx.insert(doc, { id: `${id}-d`, project_id: id, exposure });
    });
  return { cloud, space, publish };
}

/** Pulls chunks sequentially until final chunk, returning all chunks; paginates via cursor using next token. */
export function pullAll(space: Space, who: ReturnType<typeof subscribed>, request: PullRequest, limit?: number) {
  const chunks: (Poke | Chunk | Reset)[] = [];
  for (let next: PullRequest = request; chunks.length < 50; ) {
    const chunk = space.pullShared(next, who, limit);
    chunks.push(chunk);
    if (!('next' in chunk) || 'cookie' in chunk) return chunks;
    next = { ...request, cursor: chunk.next };
  }
  throw new Error('pull did not complete');
}

/** Pulls a single chunk from shared space: capped at 1 character limit, forcing 1 row per chunk. */
export const pullOne = (space: Space, request: PullRequest) => space.pullShared(request, viewer, 1);

/** Device pulls chunks sequentially until no staged chunks remain; returns issued requests. */
export async function pullRest(
  cabinet: Shared,
  space: Space,
  serve: (request: PullRequest) => Poke | Chunk | Reset = (request) => pullOne(space, request),
) {
  const requests: PullRequest[] = [];
  do {
    const request = cabinet.pullRequest();
    requests.push(request);
    expect(await cabinet.receive(serve(request))).toBe(true);
  } while (cabinet.staging() && requests.length < 20);
  return requests;
}

/** Generates subsequent pull request after landing final chunk: matches final cookie and landed subscription. */
export function landedRequest(chunks: (Poke | Chunk | Reset)[]): PullRequest {
  const last = chunks.at(-1) as Poke;
  return { cookie: last.cookie, ...(last.landed === undefined ? {} : { landed: last.landed }) };
}

/** Reconstitutes table contents by applying chunk ops sequentially; returns sorted table/key identifiers. */
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
