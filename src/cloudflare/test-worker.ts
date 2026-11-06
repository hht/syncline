import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  forward,
  forwardShared,
  type SharedDefinition,
  SynclineBroadcast,
  SynclineSharedEntry,
  SynclineSharedSpace,
  SynclineSpace,
} from 'syncline/cloudflare';

// Test Worker: private space with note and tag tables (and read-only plan) forwarded via {@link forward}; shared catalog space (/catalog)
// forwarded via {@link forwardShared}.

export const note = sqliteTable('note', { id: text().primaryKey(), text: text().notNull() });
export const tag = sqliteTable('tag', {
  id: text().primaryKey(),
  note_id: text()
    .notNull()
    .references(() => note.id),
});
/** Written only by the cloud. */
export const plan = sqliteTable('plan', { id: text().primaryKey(), text: text().notNull() });

/** Rejects rows whose column is "forbidden", passing every other value through to the remaining checks. */
const allowed = (column: string) => ({
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) =>
      (value as Record<string, unknown>)[column] === 'forbidden'
        ? { issues: [{ message: `forbidden ${column}`, path: [column] }] }
        : { value },
  },
});

/** Records triggered scheduled chore names in object storage for test inspection via RPC. */
const firedIn = (ctx: DurableObjectState) => ctx.storage.kv.get<string[]>('fired') ?? [];
const fire = (ctx: DurableObjectState, name: string) => ctx.storage.kv.put('fired', [...firedIn(ctx), name]);

export class TestSpace extends SynclineSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    // stats errors when exportFails is set, and hangs indefinitely when exportHangs is set (simulating storage or network stalls).
    const misbehave = async () => {
      if (ctx.storage.kv.get('exportFails')) throw new Error('Export failed');
      if (ctx.storage.kv.get('exportHangs')) await new Promise(() => undefined);
    };
    // Exporters record received non-empty chunks and positions in object storage: writes only when position matches from, then updates next.
    const destination = (key: string) => ({
      position: async () => ctx.storage.kv.get<string>(`${key}:position`),
      write: async ({ from, next, reset, patch }: { from: string | undefined; next: string; reset: boolean; patch: unknown[] }) => {
        if (key === 'exported') await misbehave();
        if (ctx.storage.kv.get<string>(`${key}:position`) !== from) return;
        if (reset || patch.length > 0) ctx.storage.kv.put(key, [...(ctx.storage.kv.get<unknown[]>(key) ?? []), { reset, patch }]);
        ctx.storage.kv.put(`${key}:position`, next);
      },
    });
    super(
      ctx,
      env,
      { note, tag, plan },
      {
        readOnly: [plan],
        validation: new Map([[note, allowed('text')]]),
        retired: ['note.color'],
        events: (event) => ctx.storage.kv.put('events', [...(ctx.storage.kv.get<string[]>('events') ?? []), event.type]),
        exports: { stats: destination('exported'), search: destination('searched') },
        // Sets alarm time budget to 1 second so hanging exporter tests avoid 10-minute timeouts.
        exportBudget: 1000,
      },
    );
  }

  /** Returns the types of events reported so far for test assertions via RPC. */
  events() {
    return this.ctx.storage.kv.get<string[]>('events') ?? [];
  }

  /** Returns chunks received by the exported destination for test assertions via RPC. */
  exported() {
    return this.ctx.storage.kv.get<unknown[]>('exported') ?? [];
  }

  searched() {
    return this.ctx.storage.kv.get<unknown[]>('searched') ?? [];
  }

  /** Configures the stats exporter to fail or recover. */
  failExports(value: boolean) {
    this.ctx.storage.kv.put('exportFails', value);
  }

  /** Configures the stats exporter to hang or resume. */
  hangExports(value: boolean) {
    this.ctx.storage.kv.put('exportHangs', value);
  }

  /** Deletes the underlying Durable Object alarm to simulate an external alarm override. */
  async clearAlarm() {
    await this.ctx.storage.deleteAlarm();
  }

  /** Returns the scheduled alarm epoch ms or null for test assertions via RPC. */
  alarmAt() {
    return this.ctx.storage.getAlarm();
  }

  /** Schedules a named chore via RPC, recording it in fired when executed. */
  remind(name: string, at: number) {
    this.schedule(name, at);
  }

  forget(name: string) {
    this.unschedule(name);
  }

  protected override scheduled = (name: string) => {
    fire(this.ctx, name);
    // Recurring chore: reschedules itself when executed.
    if (name === 'recurring') this.schedule(name, Date.now() + 7 * 86_400_000);
    // Resets the object without yielding, as exceeding the CPU limit does mid-task.
    if (name === 'reset') this.ctx.abort('reset');
  };

  fired() {
    return firedIn(this.ctx);
  }

  /** Returns held writes for test assertions via RPC. */
  heldWrites() {
    return this.held();
  }

  /** Resubmits a held write with its original changes. */
  retryHeld(client: string, id: number) {
    this.resubmit(client, id);
  }

  /** Server write: inserts notes; rolls back and rethrows if fail is true. */
  importNotes(notes: { id: string; text: string }[], fail = false) {
    this.mutate((tx) => {
      for (const row of notes) tx.insert(note, row);
      if (fail) throw new Error('Import failed');
    });
  }
}

const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });

/** Shared catalog definition: public bucket filters for published status; 2 broadcast shards; chunk boundary every 2 rows. */
const catalog = {
  schema: { program },
  buckets: { public: { program: { where: "status = 'published'" } }, all: { program: {} } },
  shards: 2,
  chunkRows: 2,
} satisfies SharedDefinition;

export class TestCatalog extends SynclineSharedSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      ...catalog,
      validation: new Map([[program, allowed('status')]]),
      retired: ['program.color'],
      broadcast: (bindings) => bindings.CATALOG_BROADCAST,
    });
  }

  /** Server write: upserts a program with the given status. */
  publish(id: string, status = 'published') {
    return this.mutate((tx) => tx.upsert(program, { id, status }));
  }

  /** Server write: deletes a program (changing nothing if it is missing). */
  withdraw(id: string) {
    return this.mutate((tx) => tx.delete(program, { id }));
  }

  /** Schedules a chore via RPC, recording it in fired when executed. */
  remind(name: string, at: number) {
    this.schedule(name, at);
  }

  protected override scheduled = (name: string) => fire(this.ctx, name);

  fired() {
    return firedIn(this.ctx);
  }
}

export class TestCatalogBroadcast extends SynclineBroadcast<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, env.CATALOG);
  }

  /** Configures the broadcast shard to error on notify for test simulation. */
  broken(value: boolean) {
    this.ctx.storage.kv.put('broken', value);
  }

  /** Configures the shard to error after receiving count notifications. */
  breakAfter(count: number) {
    this.ctx.storage.kv.put('healthy', count);
  }

  /** Configures the next count notifications to hang indefinitely. */
  hangNext(count: number) {
    this.ctx.storage.kv.put('hanging', count);
  }

  /** Returns the remaining number of hanging notifications. */
  hangsLeft() {
    return this.ctx.storage.kv.get<number>('hanging') ?? 0;
  }

  override notify(round: Parameters<SynclineBroadcast['notify']>[0]) {
    if (this.ctx.storage.kv.get('broken')) throw new Error('Broadcast shard failed');
    const healthy = this.ctx.storage.kv.get<number>('healthy');
    if (healthy !== undefined && healthy > 1) this.ctx.storage.kv.put('healthy', healthy - 1);
    else if (healthy !== undefined) {
      this.ctx.storage.kv.delete('healthy');
      this.ctx.storage.kv.put('broken', true);
    }
    const hanging = this.ctx.storage.kv.get<number>('hanging') ?? 0;
    if (hanging > 0) {
      this.ctx.storage.kv.put('hanging', hanging - 1);
      return new Promise<void>(() => undefined);
    }
    return super.notify(round);
  }
}

export class TestCatalogEntry extends SynclineSharedEntry<Env> {
  protected shared() {
    return this.env.CATALOG;
  }
}

/** Test token parser: returns identity with expiry; admin subscribes to all buckets, others subscribe to rule matching their name. */
const identityOf = (token: string) => {
  const [name, expiresAt, ...rest] = token.split('.');
  return name && expiresAt && rest.length === 0 ? { name, expiresAt: Number(expiresAt) } : undefined;
};

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    if (new URL(request.url).pathname === '/catalog') {
      const route = { entry: ctx.exports.TestCatalogEntry, broadcast: env.CATALOG_BROADCAST, space: 'catalog', definition: catalog };
      return forwardShared(request, route, async (token) => {
        const identity = identityOf(token);
        return identity && { buckets: [[identity.name === 'admin' ? 'all' : identity.name]], expiresAt: identity.expiresAt };
      });
    }
    return forward(request, env.SPACE, async (token) => {
      const identity = identityOf(token);
      return identity && { space: identity.name, expiresAt: identity.expiresAt };
    });
  },
};
