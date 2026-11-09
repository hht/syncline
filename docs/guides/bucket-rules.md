# Bucket rules

English | [简体中文](zh-CN/bucket-rules.md)

Bucket rules decide which rows of a shared space each device downloads. Read [Shared spaces](shared-spaces.md) first.

## What `where` can read

`where` is a SQL condition on one row. It can read only that row's columns: subqueries and other tables are refused when the space starts.

That matters when a child row should be visible only while its parent is. The child cannot look at the parent. Copy the deciding value onto every child, and change all copies in the same write.

## Example: three levels

A document has revisions, and a revision has sections. Everyone sees published documents with all their revisions and sections. Admins see everything.

Each child keeps a copy of its document's `status`. Devices don't need it, so it is a cloud-only column:

```ts
export const cloud = {
  import_progress: imports,
  revision: sqliteTable('revision', {
    id: text().primaryKey(),
    document_id: text().notNull(),
    number: integer().notNull(),
    status: text().notNull(),
  }),
  section: sqliteTable('section', {
    id: text().primaryKey(),
    revision_id: text().notNull(),
    body: text().notNull(),
    status: text().notNull(),
  }),
};
```

`where` may use cloud-only columns. The rules filter on the copies:

```ts
    public: {
      document: { where: "status = 'published'" },
      revision: { where: "status = 'published'" },
      section: { where: "status = 'published'" },
    },
    admin: { document: {}, revision: {}, section: {} },
```

Publishing a document updates the copies in the same `mutate`, so a device subscribed to `public` never sees a published document without its revisions and sections:

```ts
  setStatus(documentID: string, status: string) {
    return this.mutate((tx) => {
      tx.update(document, { id: documentID, status });
      this.#copyStatus(tx, documentID, status);
    });
  }

  /** Copies a document's status onto its revisions and sections, in the write that changes it. */
  #copyStatus(tx: Parameters<Parameters<SharedSpace['mutate']>[0]>[0], documentID: string, status: string) {
    const revisions = tx.select({ id: revision.id }).from(revision).where(eq(revision.document_id, documentID)).all();
    for (const { id } of revisions) {
      tx.update(cloud.revision, { id, status });
      for (const child of tx.select({ id: section.id }).from(section).where(eq(section.revision_id, id)).all())
        tx.update(cloud.section, { id: child.id, status });
    }
  }
```

New children copy the value when they are written:

```ts
      const [parent] = tx.select({ status: document.status }).from(document).where(eq(document.id, documentID)).all();
      if (!parent) throw new Error(`No document ${documentID}`);
      tx.upsert(cloud.revision, { id, document_id: documentID, number, status: parent.status });
      for (const child of sections) tx.upsert(cloud.section, { ...child, revision_id: id, status: parent.status });
```

One write changes at most 10,000 rows, so publishing a document whose revisions and sections add up to more throws and changes nothing. See [Bulk writes](bulk-writes.md#write-in-batches).

### Give admins both buckets

`bucketsOf` gives admins `public` as well as `admin`. Adding buckets to a token downloads only the new buckets, but removing one downloads everything again. With `public` always present, promoting a user only adds `admin`.

## Parameters

`by` turns one rule into a bucket per value: `team: { document: { by: ['team_id'] } }` gives `['team', <team_id>]`.

- Use opaque IDs, such as UUIDs, as parameters. Bucket parameters appear in download URLs, which show up wherever URLs are logged. Never use emails or names.
- Use opaque primary keys in shared tables for the same reason.
- One bucket takes at most 256 bytes as JSON.
- `by` columns must be integer or text columns that devices receive. Only `where` may use cloud-only columns.

## Subscription size

A token's buckets take at most 8,192 bytes as sorted JSON. With one UUID parameter per rule, that is about 170 buckets. Past it, `forwardShared` throws.

If users can need more, bucket by something coarser:

- Instead of a bucket per item a user can see, put a group ID on each item and subscribe to the user's groups.
- Data everyone may read needs no parameter: one bucket like `public` covers all of it.

Changing a rule moves existing rows into new buckets, with the costs below.

## Write cost

Each rule with a `where` or `by` on a table adds one billed row write per insert into that table. It adds one more per update that changes a column the rule uses. A rule with neither, like `admin`, adds nothing.

## Changing rules after launch

Changing which rules cover a table makes every device download that whole table again. Devices keep showing the old rows until the new ones land.

- Whitespace and letter case outside string literals don't count as a change.
- Adding or removing a rule on a table counts: the table is downloaded again.
- After the deploy, the cloud recounts the table in steps of up to 20,000 rows.
- Online devices hear about the change within 1 hour.
- A row that a new rule places in a bucket over 256 bytes stays in the space, but no device can subscribe to that bucket.

So for a large table, each rule change costs every device a full download of it, and costs you the rows read. Settle rules before launch where you can, and group changes into one deploy.
