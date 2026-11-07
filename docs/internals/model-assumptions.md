# Model assumptions

Details for [Models and model checking](model.md): model conclusions hold only when these assumptions are satisfied. Each item describes what the assumption is, why the model can simplify it, and how it is guaranteed (by tests, platform guarantees, or probability).

## Assumptions guaranteed by the implementation

- A local write is atomic: row changes and the mutation ID take effect simultaneously; integrator SQL statements cannot begin or commit transactions directly.
- Applying a cloud patch on a device is a single local transaction: reverting pending writes, applying ops, deleting confirmed writes, replaying remaining writes, and advancing the cookie take effect simultaneously. If synced tables were modified outside Syncline and revert fails to match, an error is raised and a full refetch is triggered (`conflicts.test.ts`).
- Exactly one `Device` instance exists per database at any time; a device maintains at most one connection and one pull concurrently; client IDs are mutually distinct; system backups produce consistent snapshots. At most one connection at a time is verified at every simulation step; late-arriving pull responses from a prior connection are invalidated by connection identity (covered by simulation backgrounding).
- Scope changes commit in the same transaction as their commit version; scans drop existing rows before emitting current rows in primary-key order, so a single `Enter` or `Leave` step in the model represents the entire transition; adding or dropping columns behaves identically to tables (in the model, a column is a cell).
- The final chunk of an HTTP pull returns `lmids` only for clients listed in the request, while the model returns `lmids` for all clients: devices list pending and current clients; client IDs change only on restart or database clear (with a cookie, subsequent results cannot chain and are discarded; without a cookie, accepting extra `lmids` is harmless, treating new clients as 0); because devices use only the requested clients, behavior is identical.
- Errors are strictly partitioned into two categories: those held while advancing the mutation ID (business rejections, schema violations, unrecognizable mutations, and writes touching cloud-written tables) and transient storage errors (mutation ID not advanced, retried); partitioning is guaranteed by implementation and tests.
- Local mutation IDs are assigned from the database within the write transaction; writes that error on commit but were already persisted do not reuse IDs, ensuring mutation IDs within a client are strictly distinct.
- A push batch may process any prefix that successfully executes at least one mutation (the second branch of `HandlePush` in the model); confirming any mutation in the batch allows the device to continue pushing remaining writes.
- The `first` flag on a push indicates the client's earliest pending write locally, not the first mutation of the batch: jumping mutation IDs based on the batch's first mutation would skip unacknowledged mutations from previous batches. The model pushes all pending writes in one step, where both concepts coincide.
- Fanout rounds delivered to the same broadcast shard arrive in order (invocations on the same stub arrive in order of sending, via [Durable Object Stub](https://developers.cloudflare.com/durable-objects/api/stub/) E-order). Order is not guaranteed across different stubs; during a rebuild, rounds from an older incarnation may arrive late. Because incarnations are random nonces without inherent ordering, shards treat differing incarnations on a connection as non-consecutive and query for head. This behavior is verified by `LatePush` in `Shared.tla`. A round retried after timeout uses a fresh stub and may arrive before a stalled round: shards reject rounds whose version is not newer than known versions, dropping late arrivals, except after losing their known version (`ArriveLate` in `Fanout.tla`).
- "Message loss implies connection drop, recognized by both endpoints": devices detect disconnects via heartbeats; the cloud sends only to open connections and closes them when done; network speeds so low that a message cannot transit within the heartbeat deadline may be misclassified as a disconnect and handled via reconnect.
- Schema migrations (dropped tables and columns, app rollbacks followed by upgrades, incompatible schemas) are omitted from the model; sync in the model begins only after compatibility is established (`src/device/evolution.test.ts`, `schemas.test.ts`).
- Commit nonces are unique per version: not verified by tests, guaranteed probabilistically. A space's incarnation is chosen once on creation and survives log truncation; space rebuilds are modeled only in `Shared.tla`.
- Commits are persisted to storage before notifications are sent: not verified by tests, guaranteed by Durable Object output gates.
- Point-in-time recovery count: models check a bounded number of recoveries; the implementation is unbounded; the simulation tests one more recovery than the model.
- Cloud chunk generation is atomic in the model: the volume read per request is bounded, guarded by scale gates (`src/test/scale/`).
- Log truncation: the model may truncate at any time to any version; the implementation truncates in steps only when exceeding byte limits, which is one valid execution allowed by the model. When cache contains stale copies computed before truncation, the model evaluates against the current floor (falling back to a full pull), while the implementation evaluates against the floor at computation time, both remaining valid on their respective histories.
- Push batches commit per mutation; when a storage error occurs midway through a push batch, committed mutations are retained, subsequent mutations from the error point onward are uncommitted, and the platform resets the actor.
- A push batch aborted by the platform for exceeding CPU limits commits no mutations in that round (implicit transactions commit only after the round completes); the device retries the push unchanged, modeled as push message loss; verified on real Cloudflare infrastructure by `probes/cloudflare/kill.ts`. Individual writes within limits do not exceed CPU thresholds: the most expensive write takes ~8 s, well within the 30 s limit (`push-size.ts`, `cascade.ts`).
- Confirmations emitted before recovery takes effect for commits after the recovery point may still reach devices; pending writes dropped by devices based on those confirmations are lost upon recovery: invariant P8k accounts for them as rolled back.
- Individual connection termination by the cloud (expired auth, connection limit reached, write quota exceeded): represented in the model as disconnects, handled by devices via reconnect.

## Omitted from the model: private spaces

- When a cookie is off the current history, the model disallows connections and permits only pulls; the implementation closes the connection and directs the device to pull over HTTP, producing the same result.
- Pushing pending writes in multiple batches.
- Online checksums: in the model, devices know exactly which rows are corrupted; in the implementation, devices detect only the mismatched primary-key range and re-download that entire range; the range contains the corrupted rows, and re-downloading uncorrupted rows is harmless.
- Schema compatibility evaluation, altering column types, and modifying primary keys (unsupported).
- Maximum concurrent connection limits.
- Full refetch on failed revert of pending writes (synced tables modified outside Syncline) or local table upgrades: in the implementation, the connection stays open while pulling over HTTP; `Refetch` in the model covers only user-requested resyncs (disconnect, pull to head, reconnect) that keep pending writes; `resync({ discardPending: true })` first reverts pending writes and, if that revert fails, clears synced tables (not modeled); a table returning to sync is wiped on open, before the refetch lands (not modeled). Landing matches `Refetch` (full pull with pending writes replayed), guarded by `src/device/conflicts.test.ts` and `src/device/upgrade.test.ts`.

## Omitted from the model: shared spaces

- When a shard cannot retrieve the head version, it may send only a hint or omit catch-up, and must not send an empty catch-up chained onto the device's cookie: doing so would drop changes in `(device cookie, shard version]` (mutating catch-up in `Fanout.tla` this way causes `MCFanout` to report a `Covers` violation).
- Backoff affects only timing, not eventual execution: model liveness assumes a finite bound on failures.
- Point-in-time recovery: omitted for shared spaces because version nonces prior to the recovery point remain unchanged, causing chunk cache keyed by position to splice together histories from before and after recovery.

## Omitted from the model: both spaces

- Auth and token renewal, protocol versions, exports, and local-only tables.
- Opening a database at most once per process, with foreground taking over from background sync.

## Platform behaviors not yet verified on physical devices

The implementation relies on these behaviors, while tests currently verify them only on Node.js or simulators:

- System-woken background tasks share the same JavaScript runtime with the UI.
- Swapping in shadow tables when views exist on synced tables: temporarily enabling `legacy_alter_table` during renames allows views to read from the new table on device databases (tested on Node.js).
- Web recovery via range pulls after local rows are corrupted (tested and repaired on physical mobile devices).
- Daily execution time for checksum verification of up to 1,000,000 rows on low-end Android hardware (measured only on simulators and Node.js).
- Message passing between the main page and Worker on web: page-side behavior is tested, while Worker-side behavior relies on browser manual testing.
- Space identity: recorded by the device on initial sync, halting on subsequent mismatches; account switches before initial sync cannot be identified.
