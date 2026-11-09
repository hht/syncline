# Exports

English | [简体中文](zh-CN/exports.md)

An exporter copies a private space's rows somewhere else: a database for cross-user queries, analytics, search. Only private spaces (`SynclineSpace`) have exporters.

This guide builds one that writes to D1. The code is in [`examples/cloudflare/notes.ts`](../../examples/cloudflare/notes.ts).

## The contract

An exporter has two methods:

- `position()` returns the position your destination stored last, or `undefined` before the first export.
- `write({ from, next, reset, patch })` writes one chunk of changes and stores `next` as the new position.

Store the rows and `next` together, and only while the stored position still equals `from`. A retried or overlapping call then changes nothing. Throw on failure; Syncline delivers the chunk from the same position again.

`patch` holds these operations:

| `op` | Meaning |
|---|---|
| `put` | The whole current row, every synced column |
| `del` | The row with this key is gone |
| `clear` | Drop all rows exported for this space; a full snapshot follows |
| `drop` | A table, or with `columns` some of its columns, left sync |

## A D1 exporter

The destination tables:

```sql
CREATE TABLE exported_note (space TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (space, id));
CREATE TABLE export_position (space TEXT PRIMARY KEY, position TEXT NOT NULL);
```

Every statement carries the same condition: the stored position is still `from`.

```ts
// Runs a statement only while the space's stored position (?1, ?2) is still the chunk's from.
const current = '(SELECT position FROM export_position WHERE space = ?1) IS ?2';
```

Each operation becomes one guarded statement:

```ts
function statementOf(db: D1Database, at: unknown[], op: Op) {
  if (op.op === 'clear' || (op.op === 'drop' && op.table === 'note' && !('columns' in op)))
    return db.prepare(`DELETE FROM exported_note WHERE space = ?1 AND ${current}`).bind(...at);
  if (op.op === 'put' && op.table === 'note')
    return db
      .prepare(
        `INSERT INTO exported_note (space, id, body) SELECT ?1, ?3, ?4 WHERE ${current} ON CONFLICT DO UPDATE SET body = excluded.body`,
      )
      .bind(...at, op.row.id, op.row.body);
  if (op.op === 'del' && op.table === 'note')
    return db.prepare(`DELETE FROM exported_note WHERE space = ?1 AND id = ?3 AND ${current}`).bind(...at, op.key.id);
  return undefined;
}
```

The last statement of the batch saves `next`, under the same condition:

```ts
    write: async ({ from, next, patch }) => {
      const at = [space(), from ?? null];
      const statements = patch.flatMap((op) => statementOf(db, at, op) ?? []);
      const save = `INSERT INTO export_position (space, position) SELECT ?1, ?3 WHERE ${current} ON CONFLICT DO UPDATE SET position = excluded.position`;
      await db.batch([...statements, db.prepare(save).bind(...at, next)]);
    },
```

D1 runs a [batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) as one transaction. Every statement is guarded anyway, so a second call with the same `from` finds the position moved on and writes nothing.

Wire it into the space, one destination position per space:

```ts
    super(ctx, env, { note }, { exporters: { d1: exportNotes(env.EXPORTS, ctx.id) }, ...exportDelay });
```

The exporter reads the space's name only when it runs. An object without a name makes it throw, so the export retries instead of writing under another key:

```ts
  const space = () => {
    if (id.name === undefined) throw new Error('This space has no name to export under: reach it with getByName');
    return id.name;
  };
```

Cloudflare gives an object its name only when it is reached by a name of at most 1,024 bytes ([`name`](https://developers.cloudflare.com/durable-objects/api/id/#name)).

## Timing

- The first export runs about 60 seconds after a write (`exportDelay`). When checking by hand, wait at least that long before querying the destination.
- A failed export retries with backoff, up to 1 hour apart.
- One alarm exports for at most 10 minutes (`exportBudget`), then continues in the next.
- An exporter added by a deploy gets the space's full snapshot the next time that space's object starts, or on its next write.

In tests, set `exportDelay` to 0. See [Testing](testing.md).

## After a rebuild or restore

A rebuilt space, or one restored with `restoreSpace` to a time before your destination's last export, no longer recognizes the position your destination kept. Its next export is a full snapshot:

- `reset` is `true`.
- `patch` starts with `clear`.

Delete every row you exported for this space, then write the snapshot. In the example, that `clear` deletes only this space's rows. Its test rebuilds a space and checks that only the new rows remain.

After `restoreSpace`, this happens on the space's next write.
