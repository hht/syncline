import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Chunk } from '../../src/protocol/messages.ts';
import { admin, cabinet, contents, doc, project, pullAll, rules, subscribed, viewer } from '../support/test-cabinet.ts';

// Row counts per bucket in shared spaces: used to compute total rows for full-pull progress; updated on writes,
// recounted in background when rules change or tables enter sync; no progress reported until counting finishes.

/** Counts all rows in the background: up to `rows` rows per step. */
function countAll(space: Space, rows?: number) {
  for (let steps = 0; space.bucketRows?.step(rows); steps += 1) if (steps > 1000) throw new Error('Counting did not complete');
}

/** Returns the progress on the first chunk of a full pull (one row per chunk with further chunks following). */
const firstProgress = (space: Space, who: ReturnType<typeof subscribed>) => (space.pullShared({ cookie: null }, who, 1) as Chunk).progress;

/** Returns how many rows are currently visible to this subscription (counted by completing a full pull). */
const visible = (space: Space, who: ReturnType<typeof subscribed>) => contents(pullAll(space, who, { cookie: null })).length;

const hidden = { ...rules, public: { ...rules.public, project: { where: "status = 'draft'" } } };

test('full pulls report progress by row count: total is sum of rows across subscribed buckets, downloaded monotonically increases across scanned rows, omitted from final chunk', () => {
  const { space, publish } = cabinet();
  for (const id of ['p1', 'p2', 'p3']) publish(id, id === 'p2' ? 'draft' : 'published', id === 'p3' ? 'admin' : 'public');
  countAll(space);
  const chunks = pullAll(space, admin, { cookie: null }, 1);
  const progress = chunks.slice(0, -1).map((chunk) => (chunk as Chunk).progress);
  expect(progress.length).toBeGreaterThan(2);
  expect(progress.map((step) => step?.total)).toEqual(progress.map(() => 6));
  const downloaded = progress.map((step) => step?.downloaded ?? -1);
  expect(downloaded).toEqual([...downloaded].sort((a, b) => a - b));
  expect(downloaded[0]).toBeGreaterThan(0);
  expect(chunks.at(-1)).not.toHaveProperty('progress');
  expect(firstProgress(space, viewer)?.total).toBe(visible(space, viewer));
});

test('writes update bucket row counts: inserts, bucket moves, cascade deletes, and multiple updates within one write count once; total matches visible rows on subsequent full pull', () => {
  const { space, publish } = cabinet();
  publish('p1');
  publish('p2');
  countAll(space);
  space.mutate((tx) => tx.update(project, { id: 'p1', status: 'draft' }));
  space.mutate((tx) => tx.delete(project, { id: 'p2' }));
  space.mutate((tx) => {
    tx.insert(project, { id: 'p3', status: 'draft' });
    tx.update(project, { id: 'p3', status: 'published' });
    tx.insert(doc, { id: 'p3-d', project_id: 'p3', exposure: 'admin' });
  });
  expect(firstProgress(space, viewer)?.total).toBe(visible(space, viewer));
  expect(firstProgress(space, admin)?.total).toBe(visible(space, admin));
});

test('deployment updates bucket rules: full pulls omit progress until counting completes (entire pull without progress); total reflects new rules after background count while unchanged rules report normally', () => {
  const { cloud, space, publish } = cabinet();
  for (const id of ['p1', 'p2', 'p3']) publish(id, id === 'p2' ? 'draft' : 'published');
  countAll(space);
  const same = new Space(cloud, [project, doc], { shared: { buckets: rules, chunkRows: 3 } });
  expect(same.bucketRows?.step()).toBe(false);
  expect(firstProgress(same, viewer)?.total).toBe(visible(same, viewer));

  const changed = new Space(cloud, [project, doc], { shared: { buckets: hidden, chunkRows: 3 } });
  const pending = pullAll(changed, viewer, { cookie: null }, 1);
  expect(pending.some((chunk) => 'progress' in chunk)).toBe(false);
  countAll(changed);
  expect(firstProgress(changed, viewer)?.total).toBe(visible(changed, viewer));
});

test('writes occurring midway through background count: rows at or before counted primary key update on write while subsequent rows await background count; total matches visible rows when done', () => {
  const { cloud, publish } = cabinet();
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) publish(id, id < 'p4' ? 'draft' : 'published');
  const changed = new Space(cloud, [project, doc], { shared: { buckets: hidden, chunkRows: 3 } });
  // Counts one table and at most 4 rows per step, alphabetical order counts doc first: two steps finish doc (6 rows), third step counts project through p4.
  for (let step = 0; step < 3; step += 1) changed.bucketRows?.step(4);
  changed.mutate((tx) => {
    tx.delete(project, { id: 'p1' });
    tx.update(project, { id: 'p4', status: 'draft' });
    tx.update(project, { id: 'p5', status: 'draft' });
    tx.insert(project, { id: 'p0', status: 'draft' });
    tx.insert(project, { id: 'p9', status: 'draft' });
  });
  countAll(changed, 4);
  expect(firstProgress(changed, viewer)?.total).toBe(visible(changed, viewer));
  expect(firstProgress(changed, admin)?.total).toBe(visible(changed, admin));
});

test('purges superseded row counts from prior generations and removed synced tables in background without leaving orphaned rows', () => {
  const { cloud, space, publish } = cabinet();
  for (const id of ['p1', 'p2']) publish(id);
  countAll(space);
  const stored = () => cloud.sql.exec('SELECT tbl, bucket, rows FROM _syncline_bucket_rows ORDER BY tbl, bucket').toArray();
  const before = stored();
  new Space(cloud, [project, doc], { shared: { buckets: hidden, chunkRows: 3 } });
  const only = new Space(cloud, [project], { shared: { buckets: { all: { project: {} } }, chunkRows: 3 } });
  countAll(only);
  expect(stored()).toEqual(before.filter(({ tbl, bucket }) => tbl === 'project' && bucket === '["all"]'));
});

test('a synced table no bucket rule covers needs no background count: one step counts the covered table and leaves no work', () => {
  const { cloud, publish } = cabinet();
  for (const id of ['p1', 'p2', 'p3']) publish(id);
  const projects = new Space(cloud, [project, doc], { shared: { buckets: { all: { project: {} } }, chunkRows: 3 } });
  // Doc holds three rows too, but they are in no bucket.
  expect(projects.bucketRows?.step(4)).toBe(false);
  expect(firstProgress(projects, subscribed(['all']))?.total).toBe(3);
});
