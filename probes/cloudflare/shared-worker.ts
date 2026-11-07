import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { SynclineBroadcast, SynclineSharedSpace } from '../../src/cloudflare/index.ts';

// Ephemeral Worker for probing platform limits (deployed by shared-write.ts and deleted when finished): a shared space with a single item table bucketed by owner, using the default number of broadcast shards.
// Requests require the randomly assigned SECRET generated at deployment time to prevent unauthorized access.

type Env = { SHARED: DurableObjectNamespace<ProbeShared>; BROADCAST: DurableObjectNamespace<ProbeBroadcast>; SECRET: string };

const item = sqliteTable('item', { id: text().primaryKey(), owner: text().notNull() });

/** Server write pattern: spread inserts rows each into a distinct bucket; move moves each spread row to a new bucket (leaving one, entering another); same inserts rows all into the same bucket. */
type Kind = 'spread' | 'move' | 'same';

export class ProbeShared extends SynclineSharedSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { schema: { item }, rules: { owner: { item: { by: ['owner'] } } }, broadcast: (bindings) => bindings.BROADCAST });
  }

  /** Returns whether bucket row counting has finished across all tables, ensuring subsequent writes adjust bucket row counts. */
  counted() {
    return (
      this.ctx.storage.sql.exec<{ left: number }>('SELECT count(*) AS left FROM _syncline_counted WHERE after IS NOT NULL').one().left === 0
    );
  }

  write(kind: Kind, rows: number) {
    return this.mutate((tx) => {
      for (let index = 0; index < rows; index += 1) {
        const id = `${kind === 'same' ? 'same' : 'spread'}-${index}`;
        const owner = kind === 'same' ? 'one' : crypto.randomUUID();
        if (kind === 'move') tx.update(item, { id, owner });
        else tx.insert(item, { id, owner });
      }
    });
  }
}

export class ProbeBroadcast extends SynclineBroadcast<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, env.SHARED);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const space = url.searchParams.get('space');
    // Rejects requests when SECRET is not configured or does not match.
    if (!space || !env.SECRET || url.searchParams.get('secret') !== env.SECRET) return new Response(null, { status: 403 });
    const shared = env.SHARED.getByName(space);
    if (url.pathname === '/counted') return Response.json(await shared.counted());
    await shared.write(url.searchParams.get('kind') as Kind, Number(url.searchParams.get('rows')));
    return Response.json(true);
  },
} satisfies ExportedHandler<Env>;
