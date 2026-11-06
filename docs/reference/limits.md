# Limits

Before integrating, read [Tables and columns](#tables-and-columns) and [Writes](#writes): they constrain the schema and the app's writes. [Platform requirements](#platform-requirements) are at the end.

## Sizes

### Tables and columns

| Item | Limit | Behavior when exceeded |
|---|---|---|
| Column types | Only integer, real, and text storage types (BLOB, bigint, and numeric are not supported); existing columns cannot change storage types; non-null columns added to existing tables need a constant default; applies to local-only tables too | Throws on opening the database or instantiating `SynclineSpace` |
| Names, primary keys, foreign keys | Names use only ASCII letters, digits, and underscores, and cannot start with a digit; table names hold at most 64 characters (shared space pull URLs carry them) and ignore case as in SQLite, so names differing only by case are one table, declared under the case it is stored as; table names cannot start with `_syncline_`; columns cannot be named `_extra` (the column where Syncline keeps columns only a newer release declares; local writes leave it unchanged, whatever SQL they run, and drop a value an insert gives); every table (local-only included) needs a primary key; foreign keys can only reference the primary key of a synced table in the same space | Throws on opening the database or instantiating `SynclineSpace`; on devices, a foreign key to a non-key column instead fails opening asynchronously (`downloadError`, `sync()` rejects) |
| Indexes and defaults | Unique, partial, and expression-based indexes are not supported; default values must be constants | Throws on opening the database |
| Primary key of a synced row | 512 bytes encoded as JSON (UTF-8) | Local writes throw `ValidationError` and roll back entirely; server writes throw `ValidationError`; the cloud holds pushed writes |
| Single row | Synced columns total 1,900,000 bytes (DO rows cap at 2 MB, leaving headroom) | Local writes throw `ValidationError` and roll back entirely |
| Text values | Well-formed UTF-16 (no lone surrogates) | Local writes throw and roll back entirely; server writes throw `ValidationError` (values given as SQL expressions or filled in by `$defaultFn` are not checked); the cloud holds pushed writes; schedule and exporter names throw |
| Number values | Finite; NaN is refused because SQLite stores it as NULL (an invalid `Date` becomes NaN); -0 is stored as 0 | Local writes throw and roll back entirely, and reads given a NaN parameter throw; server writes throw `ValidationError` (values given as SQL expressions or filled in by `$defaultFn` are not checked); the cloud holds pushed writes |

### Writes

| Item | Limit | Behavior when exceeded |
|---|---|---|
| Single local write | 8 MiB (UTF-8) | Throws during the write, rolls back entirely |
| Rows modified by a single write | 100,000 rows (shared spaces support only server writes, up to 10,000 rows: each row must also maintain its buckets), and primary keys total 16 MB encoded as JSON (UTF-8); cascaded deletes count too | Local writes throw and roll back entirely; server writes throw and roll back entirely, even if the write catches the error and goes on; the cloud holds pushed writes. If cascaded deletes exceed the limit, delete child rows in batches before the parent row |
| Single server write | Batches of a few thousand rows | CPU grows with rows written, and a write exceeding the CPU time limit resets the object. Measured in shared spaces with a column-based bucket rule: 10,000 rows took about 2 seconds of CPU to insert into one bucket and 5 seconds to move each row to another bucket |
| Upload quota for a private space (`writeQuota`) | Refills `rate` rows per second up to `burst` rows; a batch larger than `burst` runs once fully accumulated | The batch is not executed; closes the connection with 1013, and the device retries after backoff |
| Daily uploads for a private space (`dailyWrites`) | Uploads write up to `dailyWrites` billed rows per UTC day (indexes and commit log included; server writes and Syncline exports do not count); a batch runs while the limit is not yet reached, even if it goes past it | Further uploads are not executed; closes the connection with 1013, and the device retries after backoff, resuming the next day |
| Connections to a private space | 32 concurrent connections (`connections`) | A new connection closes the oldest one with 1008 |

### Downloads

| Item | Limit | Behavior when exceeded |
|---|---|---|
| Full device download | Peak local disk use is roughly 1.1x the final database file for a first download, and roughly 2x when refetching over existing data (old and new tables side by side); under WAL mode a checkpoint threshold of roughly 4 MB adds to it; the file shrinks back in steps afterwards | An interrupted download (killed in background, disk full) resumes from the last chunk; an app update that adds or drops columns or adds indexes on these tables mid-pull restarts it. On completion, triggers the app created on synced tables are dropped, and only standard column indexes are recreated (unique, partial, and expression-based indexes are omitted), renamed to `<originalName>#<number>` |
| Tables entering sync on deploy, added synced columns, changed bucket rules | Each device whose data predates the deploy re-downloads the table once, seeing old rows until it lands; in shared spaces, every device subscribed to a bucket of a changed rule does (devices with identical subscriptions share cached chunks). Changing only a rule predicate's whitespace or casing re-downloads nothing (its cloud index is still rebuilt once); other rewrites re-download even if visible rows are unchanged | Online devices are told to pull; peak local disk use matches a full refetch |
| Online checksums (private spaces) | Each device verifies its data against the cloud when newly installed, after a reset, and a full day after the previous round completed, while no writes are pending (a device clock set back before the round completed, or before the day's budget started, counts that day as passed); each device requests at most 1,000,000 rows per day (`checksumRowsPerDay`; billed per row read on the cloud, roughly \$0.03/month), so a round over a large space takes several days (roughly 10 days for 10,000,000 rows) | A mismatched section is re-downloaded (pending writes kept) and verified again; repeated mismatches are reported and skipped |

### Cloud storage

| Item | Limit | Behavior when exceeded |
|---|---|---|
| Single space data | 10 GB (Durable Object storage limit) | Writes fail; uploads keep failing (`push.failed`) |
| Private space commit log | The greater of roughly 64 MiB and 1/4 of the data | Background maintenance truncates the oldest commits; devices and exporters that last synced before the truncated point re-download from scratch (keeping pending writes) |

### Shared spaces

| Item | Limit | Behavior when exceeded |
|---|---|---|
| Subscription per device | Computed by the entrypoint from the token (the integrator's `verify`): sorted canonical bucket names total at most 8,192 bytes encoded as JSON (roughly 170 buckets when rules have a single UUID parameter); at most 256 bytes per bucket | The entrypoint throws if the subscription exceeds the limit; row writes fail if they leave a row in a bucket over the limit (server write throws); existing rows that a newly deployed rule places in such a bucket stay in the space but no device can subscribe to that bucket, until a write moves them out of it |
| Shared space name | The name with its longest shard suffix (`#127` with the default 128 shards) fits in 1,024 bytes (UTF-8): longer names do not reach the Durable Object | The shared space throws on every request |
| Bucket rules | Each rule with a predicate or bucket columns builds a cloud index: inserting a row or updating indexed columns adds 1 billed row write per rule; new or edited rules on existing tables build their index in background maintenance | A table can belong to at most 4,064 rules |
| Publishes within a single request | Each awaited publish sends one round to every shard (default 128 shards, one subrequest each); concurrent publishes coalesce into at most two rounds per shard. Cloudflare limits subrequests per invocation ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)): 10,000 by default on paid plans, roughly 78 sequential publishes | Shards beyond the limit fail with `notice.failed`; the write still succeeds, and an alarm redelivers to them about 1 second later |

## Durations

| Item | Value |
|---|---|
| Network stall | If no data is received for 30 seconds from connection start (handshake included) or during an HTTP download, the attempt fails and is retried with backoff |
| Heartbeat | Sends a ping after being idle for 25 seconds, and if no message arrives within 30 seconds, treats the connection as broken. While an upload batch is unconfirmed, pings pause for as long as its bytes take at 1 KB/s (up to about 2.3 hours for a single 8 MiB write); a silent disconnect in that window goes unnoticed until the pause ends, unless the operating system's TCP retransmission timeout breaks the connection first (while bytes are still unacknowledged) |
| Live updates | Changes reach connected devices over the WebSocket when a message fits in 24,000 bytes (UTF-8); otherwise, and in shared spaces whenever a round is too large for a shard's connections, the device receives a hint and pulls over HTTP after a random wait between 0 and max(spread, 1 second) (`spread` as in reconnection backoff). Keep shared writes small where live updates must stay fast |
| Reconnection backoff | Retry n waits a random duration between 0 and max(spread, min(30 seconds, 1 second * 2ⁿ)); shared space shards set `spread` from their connected device count (500 devices per second), and it is 0 for private spaces |
| Exports | 60 seconds after a write (`exportDelay`); doubles on failure up to 1 hour; exports for at most 10 minutes per alarm (`exportBudget`), failing if the exporter does not respond before timeout |
| Point-in-time recovery | Private spaces only (`restoreSpace`), within 30 days; freshly created objects have no restorable history for roughly the first minute. Shared spaces do not support it; re-import to revert data; rebuilds (replacing with an empty object and re-importing) are supported |
| Re-scanned tables after shared space deployment | Online devices are notified within 1 hour at latest (objects wake once per hour; earlier on server writes, device pulls, or reconnects) |
| Shared space cache | First request: 60 seconds; intermediate chunks: 1 day; final chunk: 5 seconds (cached only on the cloud, by subscription). Full downloads start from the nearest chunk boundary, recorded every 1,000 modified rows by default (`chunkRows`), so devices installed around the same time share cached chunks |

## Trade-offs and known behaviors

- Background maintenance (building an index, dropping a table past its grace period) runs one step per alarm, and each step must finish within the CPU time limit of a single invocation (default 30 seconds, configurable up to 5 minutes with `limits.cpu_ms` in wrangler); a step that cannot, such as indexing a very large table, resets the object and is handled as below.
- A scheduled task (background maintenance step, export, or `scheduled` callback) whose run never finishes (it resets the object by exceeding the CPU time limit, or hangs until the alarm is cancelled) runs again after 15 minutes, alone, and so does each task cut off with it. Runs are counted whatever reset the object (a deployment or another request exceeding the CPU limit counts too). After 3 such runs in a row it waits a day before each further attempt, reported each time: `upkeep.failed` or `export.failed` for Syncline tasks, `reportError` for `scheduled` callbacks. Rescheduling does not bring it closer, so after deploying a fix (or raising `limits.cpu_ms`) it still waits out the day; for a `scheduled` callback, `unschedule` then `schedule` runs it as planned.
- Cascaded deletes count the rows to delete before deleting them, reading roughly double the rows of a single-pass delete. A foreign key added to an existing table gets its cloud index from background maintenance; until then, cascaded deletes scan the child table in full.
- Tables leaving and entering sync:
  - A table that leaves the private space without being retired keeps its rows in the local database (readable through raw SQL) until it returns or the private space owner switches, which wipes the tables no space declares any more; retiring it drops it only while some space records it (declared it when that space last opened).
  - A table a shared space no longer declares is wiped when that space opens, and so is a table turning local-only from a shared space: shared owners are independent of the private owner, so no later owner switch could reach their rows.
  - Left alone are a table removed from `localOnly` that was never synced or that the app dropped since (indistinguishable from the app's own tables, even if it turns local-only again) and the tables of a shared space the app no longer opens.
  - Wiped before they are readable (keeping only pending writes, replayed on top) and re-downloaded are: a table returning to sync in any space; a table a space takes over from another space that synced it (including taking back its own table); a table a space declares that was synced before and that the app has since dropped (or renamed away) while the database was closed (dropped while it is open, pulls fail until the next open); a table a space declares for the first time while it already holds rows (written while it was local-only, or the app's own).
  - Renaming a synced table onto the name of another one a space declares goes undetected: that space keeps its rows as the other table's.
- An owner switch zeroes the previous owner's rows it wipes in the database file. Rows deleted earlier (deleted by sync, or in tables retired or dropped by earlier opens) are left as SQLite leaves deleted content: unreadable through SQL, but possibly still in the file's free space until overwritten, as Syncline enables `secure_delete` only during the switch (always on, every delete would rewrite its pages).
- Download progress is an estimate. Private spaces count bytes, so the total can grow during a pull. Shared spaces count rows across subscribed buckets at the start (a row in several buckets counts in each) and report no progress for incremental pulls, nor while background maintenance recounts a table whose rules a deploy changed or that entered sync; a recount reads the whole table once in steps of up to 20,000 rows, each step writing one row per bucket it touches, so recounting a large user-partitioned table roughly equals rewriting it. A server write moving a row in or out of a bucket adds 1 to 2 row writes per bucket.
- For roughly 60 seconds after a shared space rebuild (replacing it with an empty object and re-importing), newly installed devices may receive the previous incarnation's first chunk from cache; the cloud then tells them to reset and refetch, which may repeat within the window.
- Subscription changes in shared spaces (token rotation): Adding buckets scans only added buckets, keeping existing rows; removing buckets triggers a full re-download (old rows stay visible until it lands). Without a call to `reconnect()`, active connections continue filtering live notices by the old token until the next HTTP pull lands the new scope. Revoking access therefore takes effect for live notices at the latest one minute after the old token expires (the shard closes the connection then), whatever the device does; HTTP pulls verify the token on every request. Use short-lived tokens where revocation must be fast.
- Changing `shards` of a shared definition: after the deploy, every connected device receives one hint and pulls over HTTP. When lowering it, devices connected to a removed shard receive no live notices until the shard closes their connection, at the latest one minute after their token expires; they then reconnect to the remaining shards.
- An app that writes on roughly 48,000 launches without ever syncing lists too many clients in its pulls, and its downloads keep failing.
- Tables whose names start with `_syncline_` hold Syncline's own state and must be changed only by Syncline. If a pending write stored there cannot be read back (edited outside Syncline, or corrupted storage), the device cannot sync, open the database (`discardPending` included), or drop pending writes with `resync({ discardPending: true })`: each fails with the read error, and the app must delete the local database to recover, losing pending writes.
- App triggers on synced tables that raise errors: one calling `RAISE(ROLLBACK)` while the device lands downloaded rows or restores columns on open, or `RAISE(ABORT)` on a row a download deletes, fails that step as a whole, and none of it lands; downloads keep failing (`downloadError`), or opening keeps failing, until the app removes the trigger. `RAISE(ABORT)` on a row a download inserts or updates sets only that row aside with a warning, like a value the local column cannot hold. Either one raised while the device undoes its pending writes (before landing a download, or when opening the database) is reported as a conflict with them, and the device downloads everything again from scratch, keeping its pending writes; if the trigger also fails that download, downloads keep failing as above. `resync({ discardPending: true })` reports such a conflict too and clears synced tables instead; if the trigger also fails clearing them, it fails with the trigger's error and keeps pending writes.
- App triggers on synced tables fire each time the device undoes and redoes rows: a local write's changed rows as it commits, and pending writes as a download changing rows or confirming writes lands and as the database opens, so a trigger logging or counting changes sees each of these. One raising on undoing a change (deleting an inserted row, restoring an updated or deleted one) fails the local write making it (`Error code 4: query aborted`, without the trigger's message).
- SQLite does not enforce foreign keys (`REFERENCES`) on the app's own tables, on any platform: a download or local write deleting a synced row such a table references leaves the reference dangling, whatever its `ON DELETE` action. Foreign keys between synced tables follow their declarations instead (see [Tables and columns](#tables-and-columns)).
- Column type mismatches between device and cloud: a value the local column type cannot hold is kept aside with a warning: on open the column goes without it, and a row arriving with one is hidden from queries. If the cloud modifies such rows again, online checksums detect the mismatch in private spaces and re-download that section.

## Close codes

WebSocket close codes sent by the cloud, handled automatically by devices; a connection error shows the code in `uploadError` or `downloadError`:

| Code | Reason | Device action |
|---|---|---|
| 4000 | Missing cookie; in private spaces: cookie is off current history (requires full refetch) | Waits a random duration between 0 and max(spread, 1 second), then pulls and reconnects; not treated as a failure |
| 1007 | Cloud rejects pushed batch: unparseable, exceeds limits, or cannot determine client mutation sequence (device defect; unparseable individual mutations are held without closing the connection) | Emits `uploadError`, stops pushing for the remainder of this session while downloads continue; `sync()` fails immediately. Cleared when the database opens again (each cold start of the app; returning to the foreground does not clear it) and by `resync()`, after which the rejected batch is pushed again (rejected again unless an app update fixed it); `resync({ discardPending: true })` drops pending writes to stop the rejections |
| 4001 | Token expired | Reconnects with fresh token after backoff |
| 4002 | Protocol version mismatch, caused by cloud version | Cloud is newer: halts, `updateNeeded` is true; cloud is older: reconnects after backoff |
| 4003 | Schema fingerprint mismatch (HTTP pull returns 412 with cloud schema body) | Downloads over HTTP first, evaluated on device: connects normally if compatible; `retired` (uses table or column deleted on cloud): halts, `updateNeeded` is true; `ahead` (cloud lacks tables or mismatches): reconnects after backoff. This includes rolling back both the cloud and the app after devices synced a newer release that added a column: those devices still have the column and stay `ahead`, keeping pending writes, until the cloud declares the column again or an app release lists it in `retired` |
| 1011 | Upload processing failure (storage error, etc.) | Reconnects and retries push after backoff |
| 1008 | Too many concurrent connections for this private space; closes the oldest connection | Reconnects after backoff |
| 1013 | Upload exceeds write quota (`writeQuota`) or daily limit (`dailyWrites`, reason `daily writes`) | Emits `uploadError`, reconnects and retries push after backoff |
| 1003 | Received non-text message, or push attempted on shared space | Reconnects after backoff |
| Other (including 1006) | Deployment, network drop, rejected handshake (401; unrecognized URL query string, 400) | Reconnects after backoff |

## Platform requirements

- Cloudflare: Durable Objects backed by SQLite storage; compatibility date no earlier than 2026-04-07 (runtime automatically replies to client Close frames).
- Devices: iOS and Android require Syncline's native module (requires development build, not available in Expo Go); web local database runs in OPFS, requiring browser dedicated Web Workers to support `createSyncAccessHandle`; only one browser tab per site can use the database: once a tab opens it, the tab holds its files until it closes or reloads (even after `close()`); in another tab, opening fails with the error recorded as the private space's `downloadError`.
- `drizzle-orm` 1.0.0-rc.4.
