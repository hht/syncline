# Bulk writes

English | [简体中文](zh-CN/bulk-writes.md)

How to load a lot of data into a shared space: a first import, or filling a space again after rebuilding it.

## Write in batches

- One shared space write changes at most 10,000 rows. Rows removed by cascading deletes count too.
- A larger write throws `Mutation modified more than 10000 rows` and rolls back.
- Keep batches to a few thousand rows. A write that runs past the CPU time limit resets the object.

For scale: inserting 10,000 rows into one bucket took about 2 seconds of CPU. Moving each of them to another bucket took about 5 seconds. Each rule with a `where` or `by` adds work per row.

## Make retries safe

`mutate` can throw after its write committed, for example when the object resets while telling devices about it. So a retry must not depend on whether the failed attempt landed:

- Use `upsert` instead of `insert`, so writing a row twice leaves the same result.
- Record progress in the same write as the rows, so progress and data never disagree.

The example records progress in a cloud-only table:

```ts
/** Cloud-only table: how far each import job has got. */
export const imports = sqliteTable('import_progress', { job: text().primaryKey(), after: text().notNull() });
```

Each batch upserts its rows and its last ID in one `mutate`. A document already present whose status changes also copies it onto its revisions and sections, as [Bucket rules](bucket-rules.md) describes. Those copies count toward the 10,000 rows, and a batch over the limit fails on every retry, so re-import documents with many children in smaller batches:

```ts
  importDocuments(job: string, rows: (typeof document.$inferInsert)[]) {
    return this.mutate((tx) => {
      for (const row of rows) {
        const [before] = tx.select({ status: document.status }).from(document).where(eq(document.id, row.id)).all();
        tx.upsert(document, row);
        if (before && before.status !== row.status) this.#copyStatus(tx, row.id, row.status);
      }
      const last = rows.at(-1);
      if (last) tx.upsert(imports, { job, after: last.id });
    });
  }

  /** Returns the id of the last document a job imported, or undefined before its first batch. */
  imported(job: string) {
    const [row] = this.ctx.storage.sql.exec<{ after: string }>('SELECT after FROM import_progress WHERE job = ?', job).toArray();
    return row?.after;
  }
```

The caller sorts rows by ID and starts after the recorded one. After any error, call it again with the same job:

```ts
export async function importAll(space: DurableObjectStub<SharedSpace>, job: string, rows: (typeof document.$inferInsert)[], batch = 1000) {
  const after = await space.imported(job);
  const left = after === undefined ? rows : rows.filter((row) => row.id > after);
  for (let start = 0; start < left.length; start += batch) await space.importDocuments(job, left.slice(start, start + batch));
}
```

When the source is a database, query `WHERE id > ? ORDER BY id LIMIT ?` instead of filtering an array.

The example's test fails the third of three batches, then resumes and checks that all rows arrived.

## What connected devices see

Devices hear about each batch once it commits.

- A change whose message fits in 24,000 bytes goes to connected devices directly.
- A larger one tells devices to download it instead. Those downloads go through Workers Cache.
- A device starting from scratch during the import can get a cached start up to 60 seconds old. It then downloads the changes after that point.
- New devices start from the nearest saved point, recorded every 1,000 modified rows by default (`chunkRows`).

After a shared space is rebuilt, new devices may get old data from the cache for about 60 seconds. The cloud then makes them download again.
