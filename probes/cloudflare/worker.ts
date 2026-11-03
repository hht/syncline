import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { forward, SynclineSpace } from '../../src/cloudflare/index.ts';

// Ephemeral Worker for probing platform limits (deployed by push-size.ts, kill.ts, and cascade.ts, deleted when finished): a private space.
// Tokens are formatted as '<space>.<SECRET>'; SECRET is generated at deployment time to prevent unauthorized access.

type Env = { SPACE: DurableObjectNamespace<ProbeSpace>; SECRET: string };

/** Target table for push-size and kill probes, containing only a primary key. */
const t = sqliteTable('t', { i: text().primaryKey() });
/** Parent table and child tables for cascade probes: a narrow child table without additional indexes and a wide child table with 8 indexes (referencing parent with cascade deletes). */
const parent = sqliteTable('parent', { id: text().primaryKey() });
const narrow = sqliteTable('narrow', { id: text().primaryKey(), parent_id: text().references(() => parent.id) });
const columns = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'p', 'q', 'r', 's', 'u', 'v', 'w', 'x'] as const;
const indexed = columns.slice(0, 8);
const wide = sqliteTable(
  'wide',
  {
    id: text().primaryKey(),
    parent_id: text().references(() => parent.id),
    ...Object.fromEntries(columns.map((column) => [column, text()])),
  },
  (table) => indexed.map((column) => index(`wide_${column}`).on(table[column as keyof typeof table] as never)),
);
const schema = { t, parent, narrow, wide };
type Child = 'narrow' | 'wide';

/** Spins synchronously during validation when t primary key starts with 'spin' until the platform terminates DO execution with exceededCpu (used by kill.ts; loops by iteration count because Date.now does not advance synchronously in Workers). */
const spinning = {
  '~standard': {
    version: 1 as const,
    vendor: 'probe',
    validate(value: unknown) {
      let hash = 0;
      if ((value as { i: string }).i.startsWith('spin')) for (let turn = 0; turn < 1e13; turn += 1) hash = (hash * 31 + turn) | 0;
      return hash === 1 ? { issues: [{ message: 'unreachable' }] } : { value };
    },
  },
};

/** Generates a child row, padding wide table columns to 32 characters. */
const childRow = (child: Child, id: string) =>
  child === 'narrow'
    ? { id, parent_id: 'p' }
    : { id, parent_id: 'p', ...Object.fromEntries(columns.map((column) => [column, `${column}${id}`.padEnd(32, '.')])) };

export class ProbeSpace extends SynclineSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, schema, { validation: new Map([[t, spinning]]) });
  }

  /** Seeds parent row 'p' and child rows from index from up to from + count - 1 in batches for cascade.ts. */
  seed(child: Child, from: number, count: number) {
    this.mutate((tx) => {
      tx.upsert(parent, { id: 'p' });
      for (let n = from; n < from + count; n += 1) tx.insert(schema[child], childRow(child, String(n)));
    });
  }
}

export default {
  fetch: async (request, env) => {
    const url = new URL(request.url);
    // Seeding endpoint: /seed?space=&secret=&child=&from=&count=
    if (url.pathname === '/seed') {
      const get = (name: string) => url.searchParams.get(name) ?? '';
      if (!env.SECRET || get('secret') !== env.SECRET) return new Response(null, { status: 401 });
      await env.SPACE.getByName(get('space')).seed(get('child') as Child, Number(get('from')), Number(get('count')));
      return Response.json({ ok: true });
    }
    return forward(request, env.SPACE, async (token) => {
      const [space, secret] = token.split('.');
      // Rejects requests when SECRET is not configured or does not match.
      return space && env.SECRET && secret === env.SECRET ? { space, expiresAt: Date.now() + 3_600_000 } : undefined;
    });
  },
} satisfies ExportedHandler<Env>;
