# API

Organized by package entrypoint based on execution environment: app (`syncline/expo`, `syncline/expo/background`, `syncline/react`, `syncline/metro`) and cloud (`syncline/cloudflare`).

Most integrations require only `openSyncline` (`syncline/expo`) and `SynclineProvider`, `useQuery`, and `useSyncline` (`syncline/react`) on the app, plus `SynclineSpace` and `forward` (`syncline/cloudflare`) on the cloud. Start with the [README](../../README.md) section "Quick start", and refer below and to [Limits](limits.md) as needed.

## `syncline/expo`

iOS, Android, and web share the same entrypoint and options: bundles on mobile resolve to native module implementations, while web resolves to Syncline's dedicated Web Worker.

### `openSyncline(options): Syncline`

Opens (or creates) a local database, creates tables and adds columns according to `schema`, and starts syncing the private space. On mobile, a process can open a given database only once; opening it again throws an error (call `close` first). If a background task's `syncOnce` currently has the database open, it closes that instance first, then opens with the current options.

Opening fails in one of two ways:

- `openSyncline` throws for problems it sees without the database: a missing `userID`, a database already open on mobile, and the declaration rules checked in JavaScript (names, primary keys, column types, defaults, indexes, `readOnly`).
- Everything else rejects `waitForReady()`, shows as `downloadError`, and makes `sync()` reject. This covers rules checked against the stored database or across tables (a changed column type, a new non-null column without a default, table name case, foreign keys), `PendingWritesError`, an invalid `url`, and the database open in another tab.

Await `waitForReady()` before relying on the database. On mobile, if opening the private space fails (such as `PendingWritesError` or a changed column type), the database is closed, so the name can be opened again. After an invalid `url` it stays open: call `close()` before opening it again.

| Option | Description |
|---|---|
| `name` | Database name; the file is `<name>.db`. One per app |
| `userID` | ID of the signed-in user the private space belongs to: a non-empty string, otherwise `openSyncline` throws (`syncOnce` rejects). An app with one user passes a constant. Writes made under one `userID` never move to another, so open the database once the user has signed in. Pair each user with one private space: the space your cloud `verify` returns for this user's token. If different from the user recorded in the database, clears the previous user's private data and local-only tables, keeping shared spaces. If no user was recorded, records this one. If the previous user has pending writes, clearing is blocked and opening fails (`PendingWritesError`, with `userID` set to the previous user and `count` set to the number of pending writes): `openSyncline` still returns, recording the error as the private space's `downloadError` and rejecting `sync()` and `resync()` with it; the database is closed, so open it again (for example with `discardPending`). Have the previous user log in and finish syncing before switching users, or pass `discardPending` to drop them. Check `status().pending` before logging out, and call `sync()` first if non-zero |
| `discardPending` | Optional. Drops pending writes from the previous user when switching users (see `userID`). Ignored by `syncOnce` |
| `schema` | Synced tables: `{ tableName: drizzleTable }`. A table that already holds rows when it is first declared (such as one moved from `localOnly`) is wiped before any read and downloaded (see [Limits](limits.md)). Table names ignore case, as in SQLite: names differing only by case (across `schema`, `localOnly`, shared spaces, and `retired`) are one table, and a table must be declared under the case it is stored as, otherwise opening fails (for a shared space, `opened()` rejects); `retired` names match the stored table or column whatever their case |
| `localOnly` | Optional. Local-only tables: `{ tableName: drizzleTable }`, not synced. A table turning local-only from a shared space is wiped first (see [Limits](limits.md)) |
| `url` | Private space sync URL (`https://`), used for both WebSocket and HTTP downloads. Must not contain query parameters or `#` (Syncline appends parameters that the cloud expects). An `http://` URL, query parameters, or `#` fail the space with `downloadError` and reject `sync()` |
| `allowCleartext` | Optional. Accepts `http://` sync URLs for the private space and shared spaces, sending tokens and rows unencrypted; for local development only (such as `wrangler dev`) |
| `token` | `() => Promise<string>`, called before each connection. Return a fresh token when approaching expiration |
| `validation` | Optional. `Map<DrizzleTable, StandardSchema>`, validated during writes |
| `readOnly` | Optional. Synced tables writable only by the cloud (array of Drizzle tables). Read-only to devices; local writes modifying them throw and roll back the entire transaction. Identical to cloud `readOnly` |
| `retired` | Optional. Permanently removed synced tables and columns (`table.column`), identical to cloud `retired`. No longer synced; on open, retired columns are dropped, and so are retired tables some space records (declared it when that space last opened) (even with pending writes: reverts, drops, and replays), while a table that had left sync before keeps its rows (local-only writes included) until the signed-in user changes, like any table that left sync (see [Limits](limits.md)). Cannot be declared again, in `schema`, `localOnly`, or shared spaces: use a new name, also for the app's own tables (devices may still hold the old table) |
| `checksumRowsPerDay` | Optional. Maximum number of rows verified by online checksums per day, default 1,000,000 (computed on-demand on the cloud, billed per row read) |
| Token requirements | The cloud informs the device how long until identity expires. The device reconnects and calls `token` again between 1 and 4 minutes before expiration, when a fresh token must be returned. Firebase's `getIdToken()` refreshes when within 5 minutes of expiration on iOS and Android; on web (Firebase JS SDK) using Auth only, it refreshes only within 30 seconds of expiration, so calling it 1 to 4 minutes before expiration still returns the old token |

### `syncOnce(options, { signal }): Promise<void>`

iOS and Android only: Syncs once, intended for background tasks (the tens of seconds when the OS wakes the app while not in the foreground). Connects, pushes pending writes, pulls to the latest version, and succeeds. If the process already has the database open (the app is still alive in the background), it uses the open instance without closing it; if not open, it opens with `options` (same as `openSyncline`), closes it after syncing, and leaves no connection open. If the user opens the app during sync, `openSyncline` closes the instance and opens its own, and `syncOnce` succeeds without finishing its pass (the foreground instance syncs from then on). Fails if `signal` aborts (such as on timeout) or an error occurs (fails with `PendingWritesError` when switching users if the previous user has pending writes), closing the opened database. When iOS reclaims background execution time, the app is suspended immediately, with no guarantee that database cleanup runs to completion. Syncs private spaces only.

### `Syncline`

| Member | Description |
|---|---|
| `name` | Database name |
| `waitForReady(): Promise<void>` | Resolves once the database is open and the private space starts syncing, without waiting for the network; rejects with the reason it cannot (see above) |
| `db` | Read-only Drizzle database instance |
| `write(body): Promise<T>` | Executes a local write. `body(tx)` runs in a local transaction, where `tx` is a read-write Drizzle database instance |
| `onChange(listener): () => void` | Invoked after synced tables or local-only tables change, providing modified table names (`ReadonlySet<string>`) |
| `tablesOf(sql): Promise<string[]>` | Lists tables read by a query without executing it |
| `onHeld(listener): () => void` | Invoked when local writes are held by the cloud, providing `{ reason, changes }[]` (`reason` is cut to 1,000 characters) |
| `status(): SyncStatus` | Current sync status |
| `onStatus(listener): () => void` | Invoked whenever sync status changes |
| `sync({ signal }?): Promise<void>` | Syncs immediately, waiting until caught up and all local writes are confirmed (succeeds immediately if already up to date). Fails on errors or when `signal` aborts; fails immediately if the cloud rejected pushed writes with 1007 since sync last restarted (see 1007 in [Limits](limits.md)) |
| `resync({ signal, discardPending }?): Promise<void>` | Re-downloads synced tables from scratch, replacing local copies (used when local data is corrupted). Keeps pending writes and pushes them as usual after re-downloading. When `discardPending: true`, drops pending writes as well (used when uploads are permanently rejected with 1007): reverts them at once, keeping the other rows visible until the re-download lands; if a revert fails (synced tables modified outside Syncline, or an app trigger raising; see [Limits](limits.md)), reports why as an app error (`reportError`) and clears synced tables instead |
| `reconnect(): void` | Reconnects immediately and re-invokes `token`. Call when credentials change (updating permissions and visible scopes for shared spaces), such as inside Firebase's `onIdTokenChanged` |
| `openShared(name, { schema, url, token?, userID? })` | Opens a read-only shared space in the same database, with its own `waitForReady`, `status`, `onStatus`, `sync`, `resync`, and `reconnect`. Throws for the declaration rules `openSyncline` checks in JavaScript, and when `name` is already open with a different `url` or `userID`. Its `waitForReady()` rejects when the declaration is refused, the database failed to open, or the `url` is invalid. Its tables are created in the background: if that fails (such as a changed column type), `waitForReady()` still resolves, and the failure shows as its `downloadError` while it retries. The cloud determines visible rows based on token (defaults to private space token if omitted). If `userID` (signed-in user) differs from last time, clears previously viewed rows before any query issued after this call runs, even if the space then fails to open (such as a release changing a column type), unless the declaration itself is rejected (such as a table name already used by another space, or a retired name). A table the space no longer declares is wiped when it opens, and a table it declares for the first time that already holds rows is wiped before any read (see [Limits](limits.md)) |
| `close(): Promise<void>` | Stops sync and closes the database |
| `delete(): Promise<void>` | Closes the database and deletes database files (clearing local data) |

### Types

`Database` (Drizzle database), `Schema`, `OpenOptions` (the options of `openSyncline`), `Syncline`, `SharedSpace` (returned by `openShared`), `Held` (one element of the array `onHeld` passes), `SyncStatus`, `ValidationError` (modified row violates schema; `issues` provides field paths and reasons), `PendingWritesError` (see `userID`), `AccountMismatchError` (the space reported by the cloud differs from the space recorded on first sync, indicating an account switch on this device: sync halts without pushing, reported in `downloadError`, with `stored` and `cloud` identifying both spaces; reopen under the current account, switching `userID`).

## `syncline/expo/background`

Optional, iOS and Android only. Requires `expo-background-task` and `expo-task-manager`. Add `expo-background-task` to `plugins` in `app.json`.

| Export | Description |
|---|---|
| `defineBackgroundSync(options)` | Defines background sync execution, called at the top level of the entry module. `options` is `() => OpenOptions \| undefined` (can return a Promise) specifying the database to sync; does nothing when returning `undefined` |
| `startBackgroundSync({ minimumInterval }?)` | Schedules the operating system to periodically wake the app to sync, at least `minimumInterval` minutes apart (default and minimum: 15) |
| `stopBackgroundSync()` | Stops scheduled background sync |

## `syncline/react`

Must be used inside TanStack's `QueryClientProvider`.

| Export | Description |
|---|---|
| `SynclineProvider` | `<SynclineProvider value={space}>`: Provides a database to the subtree; `value` can be `undefined` (logged out). Clears the query cache of the previous database when switching databases or unmounting |
| `useQuery(build)` | `build(db)` defines a Drizzle query; returns TanStack query results, re-running only when read tables change. A changed SQL text or parameter (such as a captured variable) makes it a new query |
| `useSyncline()` | Returns the current database instance (used for writes, manual sync, and shared spaces); throws if missing |
| `useSyncStatus()` | Returns the current database sync status, triggering re-renders on change |

## `syncline/metro`

`withSyncline(config)`: Wraps the integrator's Metro configuration (`metro.config.js`) and returns the modified configuration: downloads the web WebAssembly binary of the installed release when Metro first starts (needs access to GitHub, throws if the download fails or its checksum does not match), bundling `.wasm` as an asset.

## `syncline/cloudflare`

### `class SynclineSpace<Env>`

Durable Object for private spaces. Extend it: `super(ctx, env, schema, options?)`, creating tables and adding columns according to `schema` (shared with devices). As on devices, table names ignore case: a table must be declared under the case it is stored as, and declared names cannot differ from `retired` ones only by case, otherwise instantiation throws; `retired` names match the stored table or column whatever their case. A retired table is dropped by a background alarm 30 days after it was first retired (time to undo a mistake); a retired column stays in storage, unused (dropping a column rewrites the table).

| Option | Description |
|---|---|
| `cloud` | Cloud tables: cloud-side definitions of synced tables (adding cloud-only columns) and cloud-only tables |
| `retired` | Permanently removed tables and columns (`table.column`), never returning to sync, identical to device declarations; cannot be re-declared |
| `validation` | Same as devices: re-validates uploaded client writes and server writes on the cloud |
| `readOnly` | Synced tables writable only by the cloud, identical to device declarations: modified only by server writes (`mutate`). Device writes touching them are held (pushed only by modified clients), and resubmitting them also throws if they touch read-only tables. Must not reference tables writable by devices (cascaded deletes would delete their rows); checked on open. To change an existing table to read-only, deploy app updates that stop writing to it first: un-upgraded apps writing to it will have those writes held |
| `onEvent` | Callback for cloud events |
| `writeQuota` | Token-bucket rate limit on pushed writes from devices: `{ rate, burst }`. Refills `rate` rows per second up to `burst` rows (counted as row changes); closes the connection with 1013 when exceeded. Unlimited if omitted; see [Limits](limits.md) |
| `dailyWrites` | Maximum number of billed SQLite row writes from client pushes per UTC day (including indexes and commit log; server writes do not count). Closes the connection with 1013 when reached, resuming the next day. Unlimited if omitted; see [Limits](limits.md) |
| `connections` | Maximum concurrent connections (positive integer), default 32; see [Limits](limits.md). Increase for users with many devices |
| `exporters` | Exporters: name → `Exporter` (`position()`, `write(chunk)`). An exporter added by a deploy receives a space's full snapshot the next time that space's object starts, or on its next write. After point-in-time recovery, exporters re-export (with `reset`) only on the space's next write |
| `exportDelay` | Delay after writes before exporting, default 60,000 ms |
| `exportBudget` | Maximum export duration per alarm, default 600,000 ms. If an exporter does not respond within this budget, the attempt fails and is rescheduled with backoff |

| Protected member (called in your methods; instance methods, not accessible via RPC) | Description |
|---|---|
| `mutate(write)` | Server write, executed synchronously |
| `held({ limit?, after? })` | Returns held writes: `{ client, id, reason, version, at, changes }[]`. `changes` contains the raw pushed payload (may not be valid recognized changes if the device had defects; typed as `unknown`). Default page size is 100 entries; `after` is the `version` of the last entry from the previous page |
| `resubmit(client, id, changes?)` | Resubmits a held write (`changes` replaces the original changes; `[]` discards the write). Throws if no longer held, if the changes (given, or the original ones when omitted) cannot be recognized, including text with lone surrogates, if it touches read-only tables, or if it touches retired tables or columns (unlike pushes, which drop those values; pass replacement `changes` without them) |
| `schedule(name, at)`, `unschedule(name)` | Custom scheduling: invokes `scheduled(name)` no later than `at`, unless a task resetting the object delays it (see [Limits](limits.md)). Names must not start with `syncline:` and must be well-formed text (no lone surrogates) |
| `scheduled` | Override this (`protected override scheduled = (name) => …`) to handle custom scheduled callbacks |

Alarms are managed by Syncline (sharing a single alarm between exports and custom schedules); do not override `alarm()` or call `setAlarm` directly. The same applies to `mutate`, `schedule`, `unschedule`, and `scheduled` on `SynclineSharedSpace`.

### `forward(request, namespace, verify)`

Entrypoint for sync requests in the entry Worker: extracts the token and passes it to `verify`, which returns `{ space, expiresAt }` (`expiresAt` in epoch milliseconds) or `undefined`. Forwards recognized tokens to the Durable Object named `space`; returns 401 if unrecognized. Throws if `expiresAt` is not a finite number (integrator error). Web apps on any origin can sync through it: it answers the browser's CORS preflight and allows any origin to read its responses.

### `restoreSpace(namespace, name, at)`

Restores a private space to `at` (millisecond timestamp). Rejects when the object may not have restarted (such as a lost connection): the restore then stays staged and applies whenever the object next starts, so call it again; a call after a restore that did apply restores to `at` once more, discarding writes made since.

### `Shared spaces`

| Export | Description |
|---|---|
| `SharedDefinition` | `{ schema, rules, shards?, chunkRows? }`, shared between the entrypoint and shared space. `rules` defines bucket rules: rule name → table name → `{ where?, by? }` (`where` is a static SQL predicate referencing columns of that table only; `by` specifies bucket columns). A row belongs to bucket `[ruleName, ...byValues]` if it satisfies `where` and all bucket columns are non-null |
| `class SynclineSharedSpace<Env>` | Durable Object for shared spaces: `super(ctx, env, { ...definition, broadcast, validation?, onEvent?, retired? })` (`retired` matches `SynclineSpace`); `protected mutate(write): Promise<void>`. Reach it by name (`getByName` or `idFromName`): its broadcast shards are named after it, so an ID without a name (`idFromString`, `newUniqueId`) throws, as does a name too long for its shard names (see [Limits](limits.md)) |
| `class SynclineBroadcast<Env>` | Durable Object for broadcast shards: `super(ctx, env, sharedNamespace, onEvent?)`. Alarms are managed internally (closing expired connections via alarm); do not override `alarm()` or call `setAlarm` directly |
| `abstract class SynclineSharedEntry<Env>` | Cached entrypoint: implement `protected shared()`, returning the shared space namespace |
| `forwardShared(request, route, verify)` | Entrypoint in the entry Worker: `route` is `{ entry, broadcast, space, definition }`, where `entry` is `ctx.exports.<YourEntry>` itself (called with the subscription as props; an entry reached without props throws). `verify` returns `{ buckets, expiresAt }` (subscribed buckets: `[ruleName, ...params]`, passing string arguments for text columns and numbers for integer columns; bucket columns must be integer or text), or `undefined` if unrecognized (returning 401). Throws if buckets violate rules, if a bucket exceeds 256 bytes, if the JSON-encoded subscription exceeds 8,192 bytes, or if `expiresAt` is not a finite number (integrator errors); like `forward`, it lets web apps on any origin sync |


### Security

- Access ends when the token expires: HTTP pulls call `verify` every time, but an open connection keeps the space or subscription its token granted until `expiresAt`, so keep token lifetimes short where revoking access must take effect quickly.
- Shared space pull URLs carry bucket parameters and primary keys (in the cursor, and base64-encoded, not encrypted, in the landed subscription), so they appear wherever URLs are logged: use opaque IDs rather than emails or names as bucket parameters and as primary keys of shared tables.
- Syncline bounds the work of each pull but not how often a valid token pulls, and every pull the cache does not answer reads billed rows: add a rate limiting rule on the sync route if tokens can fall into hostile hands.

### Types

`Exporter` (`{ position(): Promise<string | undefined>; write({ from, next, reset, patch }): Promise<void> }`), `Identity` (`{ space, expiresAt }`), `SharedIdentity` (`{ buckets, expiresAt }`), `Bucket`, `BucketRules`, `Change` (a modified row within a write), `ValidationError`.
