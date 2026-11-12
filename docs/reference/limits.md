# Limits

English | [简体中文](zh-CN/limits.md)

Read [Schema](#schema) and [Writes](#writes) before you design your tables. Each limit says what happens when you go past it.

## Schema

### Column types

- Columns can store integers, reals, and text.
- BLOB, bigint, and numeric columns are not supported.
- A column cannot change its storage type later.
- A non-null column added to an existing table needs a constant default.
- These rules apply to local-only tables too.

An unsupported type throws when the app opens the database. A changed storage type or a non-null column without a constant default fails opening: `sync()` rejects and `downloadError` is set. For the private space, `waitForReady()` rejects too. In the cloud, breaking any of these rules makes `SynclineSpace` throw.

### Table and column names

- Use only ASCII letters, digits, and underscores.
- Don't start a name with a digit.
- Table names hold at most 64 characters.
- Table names ignore case: `Note` and `note` are the same table. Keep the spelling a table was first created with.
- Don't start a table name with `_syncline_`, and don't name a column `_extra`. Syncline reserves both.

Breaking a rule throws when the app opens the database, except a table name spelled differently from the stored table, which fails opening the same way as a changed storage type. In the cloud, `SynclineSpace` throws.

### Keys

- Every table needs a primary key, local-only tables included.
- Give every row of a synced table a primary key no other device will produce, such as a UUID. SQLite fills in a missing integer key only in local-only tables, and `autoIncrement` is allowed only there.
- A foreign key can point only at the primary key of a synced table in the same space.
- A foreign key column must have the same storage type as the column it points at, local-only tables included.
- The primary key of a synced row takes at most 512 bytes encoded as JSON (UTF-8).

An insert that leaves out a primary key column of a synced table fails, unless the column has a default. `autoIncrement` on a synced table throws when the app opens the database. In the cloud, `SynclineSpace` throws.

A foreign key to another column fails opening the private space: `waitForReady()` and `sync()` reject, and `downloadError` is set. In the cloud, `SynclineSpace` throws.

A foreign key column of another storage type throws when the app opens the database. In the cloud, `SynclineSpace` throws.

A primary key that is too long fails the write with `ValidationError`.

### Indexes and defaults

- Unique, partial, and expression indexes are not supported.
- Default values must be constants.

Breaking a rule throws when the app opens the database.

### Values

- The synced columns of one row total at most 1,900,000 bytes. Only local writes check this; a server write past Cloudflare's 2 MB row limit fails.
- Text must be valid UTF-16. Lone surrogates are refused.
- Numbers must be finite. NaN is refused, and so is an invalid `Date`, which becomes NaN. A query given a NaN parameter throws too.
- `-0` is stored as `0`.

A local write breaking a rule throws and rolls back. A server write breaking a text or number rule throws `ValidationError`, except for values given as SQL expressions or filled in by `$defaultFn`.

## Writes

### Size

- One local write holds at most 8 MiB (UTF-8).
- One write changes at most 100,000 rows. Rows removed by cascading deletes count too.
- The primary keys of one write total at most 16 MB encoded as JSON.

A local write past a limit throws and rolls back. A server write throws and rolls back, even if it catches the error and goes on.

If a cascading delete is too large, delete the child rows in batches first.

### Server writes

- Write a few thousand rows per server write at most.
- A write that runs past the CPU time limit resets the object.
- Shared spaces accept only server writes, up to 10,000 rows each.

For scale: inserting 10,000 rows into one bucket of a shared space took about 2 seconds of CPU. Moving each of them to another bucket took about 5 seconds.

### Upload quotas

Two optional limits protect a private space from runaway uploads:

- `writeQuota` refills `rate` rows per second, up to `burst` rows.
- `dailyWrites` caps the billed row writes of uploads per UTC day. Indexes and the change log count; server writes don't.

Past either one, the cloud closes the connection with 1013. The device retries later, and `uploadError` is set.

### Connections

A private space accepts 32 concurrent connections (`connections`). A new connection closes the oldest one, and that device waits a random time up to 30 seconds before reconnecting. Devices beyond the limit that stay online take turns.

### Held writes

The cloud holds a pushed write it cannot run, for example one breaking a rule above. The app hears about it through `onHeld`. Resubmit or discard it in the cloud with `resubmit`.

## Downloads

### First download

- A first download needs about 1.1 times the final database size in free disk space.
- Downloading everything again over existing data needs about 2 times.
- An interrupted download resumes from where it stopped.
- When a full download finishes, triggers the app created on synced tables are dropped. Unique, partial, and expression indexes are not recreated.

### After a cloud deploy

Adding a table, adding a synced column, or changing a bucket rule makes each device download that table again. Devices keep showing the old rows until the new ones land.

A device that stays connected to a private space through the deploy hears about it when the space next does any work, such as a write or another device connecting. The cloud then closes its connection (4000) and it downloads and reconnects.

### Data checks

Private spaces check device data against the cloud once a day: when newly installed, after a reset, and a full day after the previous round completed, while no writes are pending. Each device requests at most 1,000,000 rows per day (`checksumRowsPerDay`). Large spaces take several days per round.

A mismatched section is downloaded again. Pending writes are kept.

Shared spaces are not checked. To download one again, call its `resync()`.

## Cloud storage

- One space holds at most 10 GB. Past that, writes fail and uploads keep failing (`push.failed`).
- The cloud keeps a history of changes up to the greater of roughly 64 MiB and 1/4 of the data. A device offline for longer than that history downloads everything again, keeping its pending writes.

## Shared spaces

- A device's subscription takes at most 8,192 bytes encoded as JSON, sorted bucket names included, and at most 256 bytes per bucket. That is about 150 buckets when rules have one UUID parameter.
- The space name, with the suffix of its last shard (`#15` with the default 16 shards), fits in 1,024 bytes (UTF-8).
- Live connections are spread over 16 broadcast shards by default (`shards`). Every server write sends one billed request to each shard and waits for all of them.
- Plan for about 1,000 devices online at once per shard, and raise `shards` beyond that. Measured on Cloudflare, a change reaching all 1,000 devices on one shard added about 70 ms to the server write.
- Each rule with a filter or bucket columns adds 1 billed row write per insert, and per update of the columns it uses.
- A table can belong to at most 4,064 rules.
- New devices start from the nearest saved point, recorded every 1,000 modified rows by default (`chunkRows`).
- After a deploy changes which rows a rule covers, the cloud recounts the table in steps of up to 20,000 rows.

## Timing

- **Live updates.** Changes reach connected devices directly when a message fits in 24,000 bytes (UTF-8). Larger changes make devices download them instead.
- **Stalled connection.** If no data is received for 30 seconds, the device gives up on the attempt and retries.
- **Heartbeat.** The device sends a ping after being idle for 25 seconds, and if no message arrives within 30 seconds, it reconnects. Pings pause while a large upload is sending, for as long as its bytes take at 1 KB/s.
- **Reconnecting.** Retry n waits a random time up to max(spread, min(30 seconds, 1 second * 2ⁿ)). Shared spaces spread reconnects at 500 devices per second.
- **Exports.** Exports run 60 seconds after a write (`exportDelay`), back off up to 1 hour on failure, and run exports for at most 10 minutes per alarm (`exportBudget`).
- **Point-in-time recovery.** Private spaces can restore any point in the last 30 days (`restoreSpace`). Shared spaces cannot.

## Things to know

- **Signing out.** Opening the database for another `userID` clears the previous user's data. It fails with `PendingWritesError` instead if that user still has writes to upload.
- **App triggers.** Triggers on synced tables fire again whenever the device undoes and redoes your pending writes. A trigger that raises an error can block downloads until you remove it.
- **Many pending writes.** The device undoes and redoes every pending write each time a change arrives in the private space and each time the database opens; reads and writes wait meanwhile. With thousands of one-row writes pending, each time takes tenths of a second. One `write` of many rows is redone faster than many writes of one row each.
- **Billed rows.** An uploaded write is billed 2 row writes besides the rows it changes, index rows included. One `write` of 100 rows costs 102; 100 writes of one row each cost 300.
- **Foreign keys on your own tables.** SQLite does not enforce them. A synced row your table points at can be deleted.
- **Changing tokens.** Call `reconnect()` when a user's permissions change. In shared spaces, live updates follow the old access until at most a minute after the old token expires; downloads check the token every time.
- **Web.** Only one browser tab per site can open the database. The tab keeps it until it closes or reloads.
- **Download progress** is an estimate.
- **Large tables in the cloud.** Building an index on a very large table can run past the CPU time limit. Raise `limits.cpu_ms` in wrangler if that happens.
- **Scheduled tasks.** A task that keeps resetting the object pauses for a day after 3 tries in a row, and the failure is reported.
- **Corrupted local state.** Only Syncline may change its own tables (`_syncline_*`). If a pending write stored there cannot be read back, the device cannot sync or open the database. Delete the local database to recover; pending writes are lost.
- **Pending count.** If reading the number of pending writes fails, `status().pending` keeps the previous number until a later read works, and `sync()` rejects with the error: calls waiting at that moment, and a call whose own read fails. The write still uploads.

## Connection errors

The cloud closes a connection with codes such as these. Devices handle them on their own. Except for 4000, 4002, and 4003, the code shows in `uploadError` or `downloadError`.

| Code | Meaning | What the device does |
|---|---|---|
| 4000 | The device must download first | Downloads, then reconnects |
| 4001 | Token expired | Gets a new token and reconnects |
| 4002 | App and cloud versions differ | Stops if the cloud is newer (`updateNeeded`), else retries |
| 4003 | App and cloud schemas differ | Checks compatibility, then connects, stops (`updateNeeded`), or retries |
| 1007 | Cloud rejected a batch of uploaded writes (unreadable, or past a limit) | Stops uploading until the app restarts or calls `resync()` |
| 1008 | Too many connections | Retries within 30 seconds |
| 1011 | Cloud failed to store the upload | Retries |
| 1013 | Upload quota reached | Retries later |
| 1003 | Binary message, or an upload to a shared space | Retries |

## Requirements

- **Cloudflare:** Durable Objects with SQLite storage, and a compatibility date of 2026-04-07 or later.
- **iOS and Android:** a development build. Expo Go is not supported.
- **Web:** a browser with OPFS support in Web Workers (`createSyncAccessHandle`).
- **Drizzle:** `drizzle-orm` 1.0.0-rc.4.

## Edge cases

Rare situations. Most apps never meet them.

### Tables entering and leaving sync

- A table that leaves the private space without being retired keeps its rows until it returns or the signed-in user changes.
- Retiring a table drops it only if some space declared it when that space last opened.
- A table a shared space stops declaring is wiped when that space opens. So is a table that turns local-only from a shared space.
- A table removed from `localOnly` that was never synced is left alone. So are the tables of a shared space the app no longer opens.
- A table returning to sync, moving to another space, or already holding rows when a space first declares it is wiped before any read and downloaded again. Pending writes are kept.
- Renaming a synced table onto the name of another declared table goes undetected. The space keeps its rows as the other table's.
- A table moving between synced and local-only keeps the key behavior it was created with. One created local-only still fills in a missing integer key after it becomes synced, the same key on every device, so give every insert its key. One created synced still refuses a missing key after it becomes local-only.

### Devices

- Switching users zeroes the wiped rows on disk. Rows deleted earlier may stay in the file's free space until overwritten.
- An app that writes on about 48,000 launches without ever syncing can no longer download.
- An app update that changes columns or indexes of tables being downloaded restarts the download.
- A value the local column type cannot hold is set aside with a warning. A row arriving with one is hidden from queries.
- Rolling back both the cloud and the app after devices synced a release that added a column keeps those devices retrying without syncing. They resume once the cloud declares the column again or the app lists it in `retired`. Pending writes are kept.
- A silent disconnect while pings pause for a large upload goes unnoticed until the pause ends: up to about 2.3 hours for one 8 MiB write.
- A write uploads in one piece: a disconnect during its upload starts it over on the next connection. On a link that drops before a write finishes uploading, that write and the writes after it never upload. Keep large content in object storage such as R2 and sync a reference to it.

### Shared spaces

- Adding buckets to a subscription downloads only the new buckets. Removing buckets downloads everything again; old rows stay visible until it lands.
- Without `reconnect()`, a connection keeps filtering live updates by the old token until the next download.
- Changing `shards` makes every connected device download once. When lowering it, devices on a removed shard get no live updates until up to a minute after their token expires.
- After a deploy changes rules, online devices hear about it within 1 hour.
- A server write cut short by a restart of the shared space (the write throws) may reach connected devices only when the space next handles a request, or at its hourly wake-up, up to 1 hour later. Retrying the write delivers it at once.
- After a shared space is rebuilt, devices may first get old data from cache. The cloud then makes them download again.
- One request can await about 625 publishes before reaching Cloudflare's subrequest limit. Shards past the limit get the change about 1 second later.
- Rows a new rule places in a bucket over 256 bytes stay in the space, but no device can subscribe to that bucket.
- Rarely, a connecting device can stay behind the latest change until the next change reaches it or its token expires and it reconnects. It takes, in order: a live update the cloud gave up on (it timed out, or the shared space restarted) reaching a shard after that shard restarted, then the shard failing to look up the latest change as the device connects.

### Cloud

- Cascading deletes read about twice the rows of a plain delete.
- A foreign key added to an existing table makes cascading deletes scan the child table until its index is built.
- `writeQuota` runs a batch larger than `burst` once the quota has refilled to `burst`.
- `dailyWrites` runs a batch while under the cap, even if the batch goes past it.
- A paused scheduled task still waits out the day after you deploy a fix. For a `scheduled` callback, `unschedule` then `schedule` runs it as planned.
- A newly created space has no restorable history for about the first minute.
