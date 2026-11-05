import { env } from 'cloudflare:workers';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { type BucketRules, Buckets } from '../../cloud/buckets.ts';
import { Space } from '../../cloud/space.ts';
import { expectBounded, fillRows, measured, scale } from '../../cloudflare/test-reads.ts';
import type { Cursor } from '../../common/storage.ts';
import { defineTables } from '../../tables/table-definitions.ts';

// Shared space scaling in real Durable Objects: chunk rowsRead does not grow with table size (even with selective filters), writes succeed with many rules.

const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });

/** Runs body in a fresh object with program table created; uses private test object to avoid shared broadcast shard startup round in flight. */
const inObject = <T>(body: Parameters<typeof measured<T>>[1]) =>
  measured(env.SPACE.getByName(crypto.randomUUID()), (context) => {
    context.raw.sql.exec('CREATE TABLE program (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    return body(context);
  });

test('selective bucket filter (only final row matches): chunk rowsRead has upper bound independent of table size using index scan', () =>
  inObject(({ raw, storage, reads }) => {
    const buckets = { sparse: { program: { where: "status = 'sparse'" } } } satisfies BucketRules;
    // Table exists: rule indexes created in background; duplicated here for test setup.
    const rules = new Buckets([program], buckets);
    for (const sql of defineTables(storage, [program], [program], (table) => rules.indexes(table))) storage.sql.exec(sql);
    const space = new Space(storage, [program], { shared: { buckets, chunkRows: 100 } });
    fillRows(raw, 'program', scale, `printf('p%06d', i), CASE WHEN i = ${scale} THEN 'sparse' ELSE 'draft' END`);
    const subscribed = { subscription: ['["sparse"]'], sub: 'sparse' };
    const given: unknown[] = [];
    // Follows next to final chunk: each request is bounded.
    for (let cursor: string | undefined, step = 0; step < 10; step += 1) {
      reads.reset();
      const chunk = space.pullShared({ cookie: null, ...(cursor === undefined ? {} : { cursor }) }, subscribed);
      expectBounded(reads.total, `table has ${scale} rows, request ${step + 1}`);
      if ('reset' in chunk) throw new Error('unexpected reset');
      given.push(...chunk.patch.flatMap((op) => (op.op === 'put' ? [op.key.id] : [])));
      if ('cookie' in chunk) break;
      cursor = chunk.next;
    }
    expect(given).toEqual([`p${String(scale).padStart(6, '0')}`]);
  }));

/** count rules where rule i matches rows where status equals rule name. */
const rules = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`v${i}`, { program: { where: `status = 'v${i}'` } }]));

test('table participating in 300 bucket rules accepts backend writes without exceeding statement argument limits', () =>
  inObject(({ storage }) => {
    const space = new Space(storage, [program], { shared: { buckets: rules(300), chunkRows: 100 } });
    expect(() => space.mutate((tx) => tx.upsert(program, { id: 'a', status: 'v0' }), 0)).not.toThrow();
  }));

test('single row matching 300 rules: round payload sizes by touched rows capped at limit without replicating per rule', () =>
  inObject(({ storage }) => {
    const everywhere = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`v${i}`, { program: {} }]));
    const space = new Space(storage, [program], { shared: { buckets: everywhere } });
    const base = space.head();
    space.mutate((tx) => tx.upsert(program, { id: 'a', status: 'v0' }), 0);
    const round = space.round(64_000, base);
    expect(round.rows).toHaveLength(1);
    expect(round.rows?.[0]?.now).toHaveLength(300);
    expect(JSON.stringify(round.rows).length).toBeLessThanOrEqual(64_000);
    expect(space.round(1000, base).rows).toBeUndefined();
  }));

const task = sqliteTable('task', { id: text().primaryKey(), team: text(), title: text() });

test.for(['update', 'upsert'] as const)(
  'a server %s changing only an unindexed column writes one row (the bucket index is left alone)',
  (write) =>
    measured(env.SPACE.getByName(crypto.randomUUID()), ({ storage }) => {
      const buckets = { team: { task: { by: ['team'] } } } satisfies BucketRules;
      const rules = new Buckets([task], buckets);
      storage.sql.exec('CREATE TABLE task (id TEXT PRIMARY KEY, team TEXT, title TEXT) STRICT, WITHOUT ROWID');
      for (const sql of defineTables(storage, [task], [task], (table) => rules.indexes(table))) storage.sql.exec(sql);
      const space = new Space(storage, [task], { shared: { buckets } });
      space.mutate((tx) => tx.insert(task, { id: 'a', team: 'red', title: 'old' }), 0);
      // Only the statement writing the task row: the index rows it rewrites are billed with it.
      const exec = storage.sql.exec;
      const writes: Cursor[] = [];
      storage.sql.exec = (sql, ...bindings) => {
        const cursor = exec(sql, ...bindings);
        if (/^(update|insert into) "task"/.test(sql)) writes.push(cursor);
        return cursor;
      };
      space.mutate((tx) => tx[write](task, { id: 'a', title: 'new' }), 0);
      expect(writes.map((cursor) => cursor.rowsWritten)).toEqual([1]);
    }),
);
