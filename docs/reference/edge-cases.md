# Edge cases

English | [简体中文](zh-CN/edge-cases.md)

Rare situations. Each takes an unusual release sequence, a mistake, a platform fault, or an extreme size, so most apps never meet them. The rules every app meets are in [Limits](limits.md).

## Schema and values

### A local-only table can reuse the key of a deleted row

`autoIncrement` on a local-only table does not stop keys from being reused: after the row with the largest key is deleted, the next insert gets that key again.

### Names every JavaScript object has cannot be used

A table or column named like a property every JavaScript object has, such as `constructor` or `toString`, throws when the app opens the database. In the cloud, `SynclineSpace` and `SynclineSharedSpace` throw.

### BigInt values throw the engine's own error

BigInt values are refused. A query or write given one throws an error of the engine's own, not `ValidationError`.

### An integer too large for SQLite can fail a server write with the engine's own error

A server write refuses an integer outside the range under [Values](limits.md#values) with `ValidationError`. In a STRICT table, one too large for SQLite to store as an integer fails first with an error of the engine's own instead. Syncline creates every table STRICT unless a column has a type STRICT tables do not take, such as a cloud-only `numeric()` column.

### Negative zero is stored as zero

`-0` is stored as `0`.

## Tables entering and leaving sync

### A table leaving the private space without being retired keeps its rows

A table that leaves the private space without being retired keeps its rows until it returns or the signed-in user changes.

### Retiring a table drops it only if a space declared it at its last open

Retiring a table drops it only if some space declared it when that space last opened. Pending writes do not stop it.

### A table a shared space stops declaring is wiped

A table a shared space stops declaring is wiped when that space opens. So is a table that turns local-only from a shared space.

### Some tables no longer declared are left alone

A table removed from `localOnly` that was never synced is left alone. So are the tables of a shared space the app no longer opens.

### A table returning to sync or changing spaces is wiped and downloaded again

A table returning to sync, moving to another space, or already holding rows when a space first declares it is wiped before any read and downloaded again. Pending writes are kept.

### Renaming a synced table onto another declared table goes undetected

Renaming a synced table onto the name of another declared table goes undetected. The space keeps its rows as the other table's.

### A table moving between synced and local-only keeps its key behavior

A table keeps the key behavior it was created with. One created local-only still fills in a missing integer key after it becomes synced, the same key on every device, so give every insert its key. One created synced still refuses a missing key after it becomes local-only.

## Devices

### A token close to expiry is not renewed early

A device reconnects for a new token between 1 and 4 minutes before its token expires, but only when the token had more than 4 minutes left as the device connected.

A token with less time left is used until it expires. The cloud then closes the connection with code 4001, which shows in `downloadError`, and the device reconnects with a new token. A shared space closes the connection within a minute of the expiry; a private space closes it at its next change or upload.

Nothing is lost. To keep the code out of `downloadError`, have `token` return tokens with more than 4 minutes left.

### Dropping pending writes can clear the synced tables

`resync({ discardPending: true })` undoes the pending writes at once and keeps the other rows visible until the download lands.

If a pending write cannot be undone, Syncline clears the synced tables instead and reports why to the app's error handler. The download then fills them again. A write cannot be undone when synced tables were changed outside Syncline, or when [a trigger of yours raises an error](#a-trigger-that-raises-an-error-can-block-downloads).

### A trigger that raises an error can block downloads

A trigger on a synced table that raises an error when Syncline changes rows can block downloads, or opening the database. Remove the trigger, or stop it from raising when Syncline changes rows.

### Names that differ only by case are one name

Table names ignore case, as in SQLite. That holds across `schema`, `localOnly`, the schemas of shared spaces, and `retired`, on devices and in the cloud:

- Two tables whose names differ only by case cannot both be declared.
- A name that differs from a retired name only by case is that retired name, so it cannot be declared.
- A table must be declared under the case it is stored as. Otherwise opening fails on a device, a shared space shows the failure in its `downloadError`, and the object throws in the cloud.
- A name in `retired` matches the stored table or column whatever its case.

Keep the spelling a table was first created with.

### Rows deleted before a user switch can stay in free space

Switching users zeroes the wiped rows on disk. Rows deleted earlier may stay in the file's free space until overwritten.

### An app that keeps writing without ever syncing eventually cannot download

An app that writes on about 48,000 launches without ever syncing can no longer download.

### An app update during a download can restart it

An app update that changes columns or indexes of tables being downloaded restarts the download.

### A value the local column cannot hold is set aside

A value the local column type cannot hold is set aside with a warning. A row arriving with one is hidden from queries.

### Rolling back both sides after a column was added stops syncing

Rolling back both the cloud and the app after devices synced a release that added a column keeps those devices retrying without syncing. They resume once the cloud declares the column again or the app lists it in `retired`. Pending writes are kept.

### A silent disconnect during a large upload goes unnoticed for a while

A silent disconnect while pings pause for a large upload goes unnoticed until the pause ends: up to about 2.3 hours for one 8 MiB write.

### A write that cannot finish uploading holds back the writes after it

A write uploads in one piece: a disconnect during its upload starts it over on the next connection. On a link that drops before a write finishes uploading, that write and the writes after it never upload. Keep large content in object storage such as R2 and sync a reference to it.

### A pending write that cannot be read back stops the device

Only Syncline may change its own tables (`_syncline_*`). If a pending write stored there cannot be read back, the device cannot sync or open the database. Delete the local database with `delete()` to recover; pending writes are lost.

### A failed read of the pending count keeps the previous number

If reading the number of pending writes fails, `status().pending` keeps the previous number until a later read works, and `sync()` rejects with the error: calls waiting at that moment, and a call whose own read fails. The write still uploads.

## Shared spaces

### Switching users clears a shared space even when it then fails to open

`openShared` with another `userID` than last time clears the rows the previous user saw, before any query made after the call runs. It does so even if the space then fails to open, such as after a release changed a column type, so those rows never stay readable.

The rows stay only when the declaration itself is refused, such as a table name another space uses or a retired name.

### Removing buckets downloads everything again

Adding buckets to a subscription downloads only the new buckets. Removing buckets downloads everything again; old rows stay visible until it lands.

### Without a reconnect, live updates follow the old token

Without `reconnect()`, a connection keeps filtering live updates by the old token until the next download.

### Changing the shard count makes every device download once

Changing `shards` makes every connected device download once. When lowering it, devices on a removed shard get no live updates until up to a minute after their token expires.

### Online devices hear about changed rules late

After a deploy changes rules, online devices hear about it within 1 hour.

### A server write cut short by a restart can reach devices late

A server write cut short by a restart of the shared space (the write throws) may reach connected devices only when the space next handles a request, or at its hourly wake-up, up to 1 hour later. Retrying the write delivers it at once.

### After a rebuild, devices may first get old data from cache

After a shared space is rebuilt, devices may first get old data from cache. The cloud then makes them download again.

### Shards past the subrequest limit get a change late

One request can await about 625 publishes before reaching Cloudflare's subrequest limit. Shards past the limit get the change about 1 second later.

### No device can subscribe to an oversized bucket

Rows a new rule places in a bucket over 256 bytes stay in the space, but no device can subscribe to that bucket.

### A connecting device can rarely stay behind the latest change

A connecting device can stay behind the latest change until the next change reaches it or its token expires and it reconnects. It takes, in order: a live update the cloud gave up on (it timed out, or the shared space restarted) reaching a shard after that shard restarted, then the shard failing to look up the latest change as the device connects.

## Cloud

### A cloud-only column of an unusual type fails on existing tables

A cloud-only column declared as `text()`, `integer()`, `real()`, or `blob()`, in any mode, can be added at any time.

Other declarations, such as `text({ length: 40 })` or `numeric()`, work only in a table created with them. Added to an existing table, such a column makes the object throw when it starts. So does a synced `text({ length })` column kept as cloud-only after it leaves the schema.

A newly created space accepts the same declaration, so it can pass local development and fail once deployed. Declare the column with one of the four types above.

### Cascading deletes read about twice the rows

Cascading deletes read about twice the rows of a plain delete.

### A new foreign key slows cascading deletes until its index is built

A foreign key added to an existing table makes cascading deletes scan the child table until its index is built.

### Quotas let some batches past their limit

`writeQuota` runs a batch larger than `burst` once the quota has refilled to `burst`. `dailyWrites` runs a batch while under the cap, even if the batch goes past it.

### A task that keeps resetting the object pauses for a day

A task that keeps resetting the object pauses for a day after 3 tries in a row, and the failure is reported. A paused task still waits out the day after you deploy a fix. For a `scheduled` callback, `unschedule` then `schedule` runs it as planned.

### Building an index on a very large table can run past the CPU time limit

Building an index on a very large table can run past the CPU time limit. Raise `limits.cpu_ms` in wrangler if that happens.

### A new space has no restorable history at first

A newly created space has no restorable history for about the first minute.
