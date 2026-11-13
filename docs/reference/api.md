# API

English | [简体中文](zh-CN/api.md)

Every export, by package entrypoint.

| Entrypoint | Runs in | Exports |
|---|---|---|
| [`syncline/expo`](#synclineexpo) | The app | `openSyncline`, `syncOnce` |
| [`syncline/react`](#synclinereact) | The app | `SynclineProvider`, `useQuery`, `useSyncline`, `useSyncStatus` |
| [`syncline/expo/background`](#synclineexpobackground) | The app, on iOS and Android | `defineBackgroundSync`, `startBackgroundSync`, `stopBackgroundSync` |
| [`syncline/metro`](#synclinemetro) | Your Metro configuration | `withSyncline` |
| [`syncline/cloudflare`](#synclinecloudflare) | Your Worker | `SynclineSpace`, `forward`, `restoreSpace`, and the [shared space](#shared-spaces) exports |

Most apps need only `openSyncline`, `SynclineProvider`, `useQuery`, and `useSyncline` in the app, plus `SynclineSpace` and `forward` in the cloud. Start with the [Quick start](../../README.md#quick-start), and read [Limits](limits.md) before you design your tables.

The code on this page comes from the example under [`examples/`](../../examples).

## `syncline/expo`

iOS, Android, and web share this entrypoint and its options. On iOS and Android the database and sync run in a native module; on web they run in a Web Worker that Syncline bundles.

### `openSyncline(options)`

Opens the local database, creating it on first use, and starts syncing the signed-in user's private space.

```ts
  const syncline = openSyncline({
    name: 'app',
    userID,
    schema: { note },
    url: 'https://api.example.com/sync',
    token,
  });
  await syncline.waitForReady();
```

It returns a [`Syncline`](#syncline) at once and opens the database in the background. Await `waitForReady()` before relying on it.

| Option | Type | Description |
|---|---|---|
| `name` | `string` | Database name. The file is `<name>.db`. Use one database per app. |
| `userID` | `string` | ID of the signed-in user, a non-empty string. An app with one user passes a constant. See [Switching users](#switching-users). |
| `schema` | `{ tableName: drizzleTable }` | Synced tables. Opening creates them and adds new columns. [Schema](limits.md#schema) lists what a table can declare. A table that already holds rows when first declared, such as one moved from `localOnly`, is wiped and downloaded: see [Tables entering and leaving sync](edge-cases.md#tables-entering-and-leaving-sync). |
| `url` | `string` | Address of the private space's sync route: `https://`, without query parameters or `#`. The device connects to it and downloads from it. |
| `token` | `() => Promise<string>` | Returns the user's token. See [Tokens](#tokens). |

<details>
<summary>More options</summary>

| Option | Type | Description |
|---|---|---|
| `localOnly` | `{ tableName: drizzleTable }` | Tables kept on this device and never synced. Moving a table into or out of this list can wipe its rows: see [Tables entering and leaving sync](edge-cases.md#tables-entering-and-leaving-sync). |
| `validation` | `Map<drizzleTable, StandardSchema>` | A schema per table, checked on every write. It must answer synchronously: a schema that returns a Promise fails the write. |
| `readOnly` | `drizzleTable[]` | Synced tables only the cloud writes. A local write to one throws and rolls back. Each must be in `schema` and can reference only read-only tables, or `openSyncline` throws. Pass the same list in the cloud. |
| `retired` | `string[]` | Tables and columns (`'table.column'`) removed from sync for good. Opening drops the retired columns, and the retired tables a space declared when it last opened: see [Tables entering and leaving sync](edge-cases.md#tables-entering-and-leaving-sync). Pass the same list in the cloud. A retired name can never be declared again, in any list or for a table of your own: use a new name. See [How do I change my schema?](faq.md#how-do-i-change-my-schema) |
| `discardPending` | `boolean` | Drops the previous user's pending writes when `userID` changes. See [Switching users](#switching-users). |
| `allowCleartext` | `boolean` | Accepts `http://` URLs for the private space and shared spaces. Tokens and rows travel unencrypted: use it only for local development, such as against `wrangler dev`. |
| `checksumRowsPerDay` | `number` | Rows the daily [data check](limits.md#data-checks) may verify, default 1,000,000. The cloud reads them, which is billed. |

</details>

- **Two ways to fail.** `openSyncline` throws for what it can see in the options alone: an empty `userID`, or a table declaration breaking a rule such as an unsupported column type. What only shows once the database opens, such as a column whose type changed, rejects `waitForReady()` instead. [Schema](limits.md#schema) says which rule fails how, and [`waitForReady()` rejects](errors.md#waitforready-rejects) lists the other causes.
- **iOS and Android: one open instance per name.** Opening a name that is already open in the foreground throws. Call `close()` first.
- **Web: one database per tab, one tab per site.** Opening a database closes the one this tab has open, whatever its name; calls on the closed one fail with `Local database is closed`. A second tab [cannot open the database](errors.md#the-web-app-works-in-one-tab-only).

#### Switching users

Opening for another `userID` than last time clears the previous user's private data and local-only tables. Shared spaces are kept.

If the previous user still has writes waiting to upload, opening fails with [`PendingWritesError`](errors.md#pendingwriteserror-when-opening-the-database) and clears nothing. So upload them before the user signs out:

```ts
  if (syncline.status().pending > 0) await syncline.sync();
  await syncline.close();
```

See [How do I sign a user out?](faq.md#how-do-i-sign-a-user-out) for every step.

Writes never move from one user to another, so open the database after the user has signed in.

Each user has one private space: the `space` your cloud's `verify` returns for that user's token. If the cloud reports another space than the one this database first synced with, sync stops with [`AccountMismatchError`](errors.md#accountmismatcherror-in-downloaderror).

#### Tokens

Syncline calls `token` before each connection and, while connected, before each chunk it downloads. Cache the token if getting one is slow.

- **Return a fresh token near expiration.** A device reconnects and calls `token` again between 1 and 4 minutes before its token expires. A token returned with 4 minutes or less left is [not renewed early](edge-cases.md#a-token-close-to-expiry-is-not-renewed-early).
- **A failure is retried.** If `token` throws, resolves to `undefined` or `null`, or takes more than 30 seconds, `downloadError` is set and the device retries with backoff.
- **On sign-out, call `close()`.** Don't throw from `token`: the device would keep retrying.

<details>
<summary>Firebase Authentication</summary>

`getIdToken()` returns the cached token until it is within 5 minutes of expiring on iOS, and on web with Firebase JS SDK 13.2.0 or later. Earlier JS SDK versions refresh only within the last 30 seconds, and `@react-native-firebase` 27.1.1 uses JS SDK 13.1.0 on web. Firebase does not document when Android refreshes.

To get a fresh token on every platform, call `getIdToken(true)` when the token expires within 5 minutes.

</details>

### `Syncline`

The object `openSyncline` returns.

| Member | Description |
|---|---|
| `name` | The database name. |
| `db` | Drizzle database for reads. It cannot write: use `write`. |
| [`write(body)`](#writebody) | Runs a local write in a transaction. |
| `onChange(listener)` | Calls `listener` after synced or local-only tables change, with their names (`ReadonlySet<string>`). Returns a function that removes the listener. |
| `tablesOf(sql)` | Resolves to the names of the tables a query reads, without running it. |
| [`waitForReady()`](#waitforready) | Resolves once the database has opened. |
| `status()` | The current [`SyncStatus`](#syncstatus). |
| `onStatus(listener)` | Calls `listener` with the status whenever it changes. Returns a function that removes the listener. |
| [`sync(options?)`](#syncoptions) | Syncs now and waits until caught up. |
| [`resync(options?)`](#resyncoptions) | Downloads the synced tables again from scratch. |
| `reconnect()` | Reconnects at once and calls `token` again. Call it when the user's credentials change, such as in Firebase's `onIdTokenChanged`. |
| `onHeld(listener)` | Calls `listener` with the writes the cloud refused to run: `{ reason, changes }[]`, where `reason` holds at most 1,000 characters. Returns a function that removes the listener. See [A write appears, then disappears](errors.md#a-write-appears-then-disappears). |
| [`openShared(name, options)`](#opensharedname-options) | Opens a read-only shared space in the same database. |
| `close()` | Stops sync and closes the database. |
| `delete()` | Closes the database and deletes its files, writes not uploaded yet included. |

#### `waitForReady()`

Resolves once the database is open and the private space has started syncing. It does not wait for the network.

It rejects with the reason the database could not open, which `downloadError` shows too. See [`waitForReady()` rejects](errors.md#waitforready-rejects).

#### `write(body)`

Runs `body(tx)` in a local transaction and resolves to what `body` returns. `tx` is a Drizzle database that reads and writes.

```ts
  await syncline.write(async (tx) => {
    const [existing] = await tx.select().from(note).where(eq(note.id, id));
    if (!existing) await tx.insert(note).values({ id, body });
  });
```

- **Await only `tx` inside `body`.** Until `body` settles, every other read and write and every change from the cloud waits. A `body` that awaits a `db` query or another `write` never finishes. Anything that waits 5 seconds behind a write logs a console warning, so keep `body` short.
- **A failed write saves nothing.** If `body` throws or the write breaks a rule, the transaction rolls back and `write` rejects. See [A write throws](errors.md#a-write-throws).

#### `sync(options?)`

Syncs now. It resolves once the device has caught up and the cloud has confirmed every local write, at once if that is already so.

```ts
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Sync timed out')), timeout);
  await syncline.sync({ signal: controller.signal }).finally(() => clearTimeout(timer));
```

- **`options.signal`** is an `AbortSignal`: aborting it rejects the call with `signal.reason`.
- **It does not wait for the network.** Offline, it starts a connection attempt at once and rejects when that attempt fails.
- **It rejects with the error the status shows** as `downloadError` or `uploadError`. Of these, only `PendingWritesError` and `AccountMismatchError` can be checked with `instanceof`.
- **After an `AccountMismatchError` stopped sync**, later calls reject with `sync has not started`.
- **After the cloud rejected uploads with [1007](errors.md#uploaderror-shows-code-1007)**, it rejects at once until the app restarts or calls `resync()`.

#### `resync(options?)`

Downloads the synced tables again from scratch and replaces the local copies. Use it when local data is damaged. The rows stay visible until the download lands.

- **`options.signal`** works as in `sync`.
- **Pending writes are kept** and upload as usual after the download.
- **`options.discardPending: true` drops them too.** Use it when the cloud keeps rejecting uploads with [1007](errors.md#uploaderror-shows-code-1007).
- **A dropped write may already be in the cloud.** If the cloud ran it and the device never heard, the download brings its changes back.
- **Dropping can fail.** If a pending write cannot be undone, the synced tables are [cleared instead](edge-cases.md#dropping-pending-writes-can-clear-the-synced-tables).

#### `openShared(name, options)`

Opens a shared space in the same database. Devices only read a shared space; query its tables through `db` like any other.

```ts
  const shared = syncline.openShared('shared', {
    schema: { document, revision, section },
    url: 'https://api.example.com/shared',
    userID,
  });
```

| Argument | Type | Description |
|---|---|---|
| `name` | `string` | Local name of the space, not empty. Each shared space needs its own. |
| `options.schema` | `{ tableName: drizzleTable }` | The space's tables. A table belongs to one space: the private space, local-only tables, and other shared spaces cannot use its name. |
| `options.url` | `string` | Address of the route you pass to `forwardShared`, under the rules of `openSyncline`'s `url`. |
| `options.token` | `() => Promise<string>` | Optional; the private space's `token` by default. The cloud decides from the token which rows the device sees. |
| `options.userID` | `string` | Optional. The signed-in user. When it differs from last time, the rows the previous user saw are cleared before any later query runs. Without it, nothing is cleared. |

It returns a `SharedSpace` with its own `name`, `waitForReady`, `status`, `onStatus`, `sync`, `resync`, and `reconnect`, which work as on `Syncline`. A shared space has no pending writes, so its `resync` ignores `discardPending`.

- **Calling it again returns the open space** when `name`, `url`, and `userID` are the same; another `token` or `schema` is ignored. A different `url` or `userID` throws.
- **It throws** for an empty `name` and for the declarations `openSyncline` throws for.
- **Its `waitForReady()` rejects** when the declaration is refused (a table name another space uses, or a retired name), the database failed to open, or the `url` is invalid.
- **Its tables are created in the background.** If that fails, such as after a changed column type, `waitForReady()` still resolves. The failure shows in the space's `downloadError` while it retries.
- **Each space reconnects on its own.** `syncline.reconnect()` reconnects only the private space. See [When permissions change](../guides/shared-spaces.md#when-permissions-change).
- **Rarely met:** a user switch clears the rows [even when the space then fails to open](edge-cases.md#switching-users-clears-a-shared-space-even-when-it-then-fails-to-open), and tables that enter or leave a space are [wiped](edge-cases.md#tables-entering-and-leaving-sync).

### `SyncStatus`

What `status()` returns and `onStatus` passes: a new object on each change.

| Field | Description |
|---|---|
| `connected` | `true` when connected and caught up, receiving live changes. |
| `connecting` | `true` when started but not connected yet: getting a token, downloading, or waiting to retry. `false` while paused for an app update or stopped by `AccountMismatchError`. |
| `downloading` | `true` while a download runs. |
| `downloadProgress` | `{ downloaded, total }` from the second chunk of a download on; `undefined` otherwise. |
| `pending` | Number of local writes the cloud has not confirmed yet. |
| `hasSynced` | `true` once this space has synced, kept across restarts. |
| `downloadError` | `Error \| undefined`: why getting a token, downloading, connecting, or opening failed. Cleared by the next downloaded chunk or once caught up. |
| `uploadError` | `Error \| undefined`: why the cloud failed or refused uploaded writes. Cleared when later writes are confirmed. |
| `updateNeeded` | `true` when the cloud is newer than the app, or the app uses a table or column the cloud has retired. Sync pauses until an app update. |

### `syncOnce(options, settings?)`

iOS and Android only. Syncs the private space once: connects, uploads pending writes, downloads to the latest version, and resolves. It is meant for the tens of seconds the system gives an app it wakes in the background. Most apps use [`syncline/expo/background`](#synclineexpobackground), which calls it.

- **`options`** are those of `openSyncline`; `discardPending` is ignored. **`settings.signal`** aborts the pass.
- **If this process has the database open**, it uses that instance and leaves it open. Otherwise it opens the database, syncs, and closes it, leaving no connection behind.
- **If the user opens the app meanwhile**, `openSyncline` closes the background instance and opens its own. `syncOnce` then resolves without finishing its pass, and the foreground instance syncs from then on.
- **It rejects** when `signal` aborts, when sync fails, and where `openSyncline` would throw. It rejects with `PendingWritesError` when the previous user has pending writes. The database it opened is closed.
- **iOS can suspend the app at once** when it takes back background time, so closing the database is not guaranteed to finish.
- **Shared spaces are not synced.**

### Errors

Three error classes are exported, so `instanceof` works on them.

| Class | When | Fields |
|---|---|---|
| `ValidationError` | A written row breaks its column declaration or your `validation` schema. See [A write throws](errors.md#a-write-throws). | `table`; `issues`, each with the `path` of a field and a `message` |
| `PendingWritesError` | The database is opened for another user while the previous one has pending writes. See [`PendingWritesError` when opening the database](errors.md#pendingwriteserror-when-opening-the-database). | `userID`, the previous user; `count`, their pending writes |
| `AccountMismatchError` | The cloud reports another space than the one this database first synced with. Sync stops without uploading. See [`AccountMismatchError` in `downloadError`](errors.md#accountmismatcherror-in-downloaderror). | `stored` and `cloud`, the two spaces |

### Types

`Database` (the Drizzle database of `db` and `tx`), `Schema`, `OpenOptions` (the options of `openSyncline`), `Syncline`, `SharedSpace` (what `openShared` returns), `Held` (one element of the array `onHeld` passes), `SyncStatus`.

## `syncline/react`

Use these inside TanStack Query's `QueryClientProvider`.

### `SynclineProvider`

`<SynclineProvider value={syncline}>` provides a database to the components below it. `value` can be `undefined`, for a signed-out user.

When `value` changes or the provider unmounts, it clears the cached queries of the previous database. The [Quick start](../../README.md#4-use-it-in-your-app) shows it in an app.

### `useQuery(build)`

Runs a Drizzle query and keeps its result current. `build(db)` returns the query; the hook returns what TanStack Query's `useQuery` returns.

```ts
function useNotes() {
  return useQuery((db) => db.select().from(note));
}
```

The query runs again only when a table it reads changes. A changed SQL text or parameter, such as a captured variable, makes it a new query.

### `useSyncline()`

Returns the database the provider holds, for writes, `sync()`, and shared spaces. It throws when there is none.

```ts
function useAddNote() {
  const { write } = useSyncline();
  return (id: string, body: string) => write(async (tx) => tx.insert(note).values({ id, body }));
}
```

### `useSyncStatus()`

Returns the database's [`SyncStatus`](#syncstatus) and re-renders when it changes.

```ts
function useUnsynced() {
  const { pending } = useSyncStatus();
  return pending > 0;
}
```

## `syncline/expo/background`

Optional, iOS and Android only: lets the system wake the app to sync the private space while it is not in the foreground.

It needs `expo-background-task` and `expo-task-manager`, in the versions under [Requirements](limits.md#requirements). Add `expo-background-task` to `plugins` in `app.json`.

```ts
  defineBackgroundSync(async () => {
    const user = await session();
    return user && { name: 'app', schema: { note }, url: 'https://api.example.com/sync', ...user };
  });
```

| Export | Description |
|---|---|
| `defineBackgroundSync(options)` | Defines what a background run syncs. Call it at the top level of the app's entry module. `options` is a function returning the options of `openSyncline`, or a Promise of them. A run does nothing when it returns `undefined`. |
| `startBackgroundSync({ minimumInterval }?)` | Asks the operating system to wake the app to sync, at least `minimumInterval` minutes apart. Default and minimum: 15. |
| `stopBackgroundSync()` | Stops the background runs. |

Each run calls [`syncOnce`](#synconceoptions-settings).

## `syncline/metro`

### `withSyncline(config)`

Wraps your Metro configuration (`metro.config.js`) and returns the changed configuration, which bundles `.wasm` files as assets.

When Metro first starts, it downloads the web WebAssembly binary of the installed release. That needs access to GitHub, and it throws if the download fails or its checksum does not match. [Install](../../README.md#1-install) shows the file.

## `syncline/cloudflare`

### `SynclineSpace`

The Durable Object class of private spaces: one object per user. Extend it and call `super(ctx, env, schema, options?)` with the schema your app uses. A starting object creates the schema's tables and adds new columns. The [Quick start](../../README.md#3-set-up-the-cloud) shows a complete class.

| Option | Type | Description |
|---|---|---|
| `cloud` | `{ tableName: drizzleTable }` | Cloud-side definitions of synced tables, which can add cloud-only columns, and tables only the cloud has. See [Cloud tables](#cloud-tables). |
| `validation` | `Map<drizzleTable, StandardSchema>` | As on devices. The cloud checks uploaded writes and server writes with it. A schema must answer synchronously. |
| `readOnly` | `drizzleTable[]` | Synced tables only server writes change. Pass the same list on devices. See [Read-only tables](#read-only-tables). |
| `retired` | `string[]` | Tables and columns (`'table.column'`) removed from sync for good. Pass the same list on devices. A retired name can never be declared again. |
| `onEvent` | `(event: SynclineEvent) => void` | Called for cloud events, for logs and alerts. See [Events](errors.md#events). |

<details>
<summary>More options</summary>

| Option | Type | Description |
|---|---|---|
| `writeQuota` | `{ rate, burst }` | Rate limit on uploaded row changes: refills `rate` rows per second, up to `burst` rows. No limit when left out. See [Upload quotas](limits.md#upload-quotas). |
| `dailyWrites` | `number` | Cap on the billed row writes of uploads per UTC day. Uploads resume the next day. No cap when left out. See [Upload quotas](limits.md#upload-quotas). |
| `connections` | `number` | Most concurrent connections, a positive integer, default 32. Raise it for users with many devices. See [Connections](limits.md#connections). |
| `exporters` | `{ name: Exporter }` | Exporters copying the space into another database. See [Exports](../guides/exports.md). |
| `exportDelay` | `number` | Milliseconds between a write and its export, default 60,000. |
| `exportBudget` | `number` | Longest one alarm exports, in milliseconds, default 600,000. An exporter that has not answered within it fails that attempt and is retried with backoff. |

</details>

- **Retired tables are dropped after 30 days**, counted from when the table was first retired, which leaves time to undo a mistake. A retired column stays in storage, unused.
- **Don't override `alarm()` or call `setAlarm`.** Syncline manages the object's one alarm, which exports and your own schedules share.
- **The methods below are protected.** Call them from your own methods; they cannot be reached over RPC.

#### Cloud tables

- A cloud-side definition declares every column of the synced table with the same storage type and default, and the same primary key. Otherwise the object throws when it starts.
- Key columns take the order the table declares its columns in, so declare them in the schema's order.
- Devices never receive cloud-only columns. A server write that changes only cloud-only columns still sends the row to devices again, so keep values that change often in a table only the cloud has.
- Give cloud-only columns the types `text()`, `integer()`, `real()`, or `blob()`. [Other declarations fail on existing tables](edge-cases.md#a-cloud-only-column-of-an-unusual-type-fails-on-existing-tables).

#### Read-only tables

- A read-only table must be in the schema and can reference only read-only tables: a cascading delete from a writable table would delete its rows. Otherwise the object throws when it starts.
- A device write that touches a read-only table is [held](errors.md#held-writes). An app that declares the table read-only never pushes one: its local write throws.
- To make an existing table read-only, first ship the app update that stops writing to it. Apps not yet updated get their writes to it held.

#### `mutate(write)`

A server write: runs `write(tx)` synchronously in one transaction.

```ts
  addNote(id: string, body: string) {
    this.mutate((tx) => tx.upsert(note, { id, body }));
  }
```

`tx` is a `Transaction`: `select`, plus `insert`, `upsert`, `update`, and `delete` by primary key. A write that breaks a rule, such as a [limit](limits.md#size), throws and rolls back.

#### `held(options?)` and `resubmit(client, id, changes?)`

`held({ limit?, after? })` returns the writes the cloud holds: `{ client, id, reason, version, at, changes }[]`.

- `changes` is what the device pushed, typed `unknown`: a faulty device can push something that is not a valid change.
- A page holds at most 100 entries by default, and fewer when their changes are large. For the next page, pass the `version` of the last entry as `after`, until a page comes back empty.

`resubmit(client, id, changes?)` runs a held write again. Pass `changes` to replace the original ones, or `[]` to discard the write. It throws when:

- the write is no longer held;
- the changes, given or original, cannot be read, such as text with lone surrogates;
- the changes touch a read-only table;
- the changes touch a retired table or column. An upload drops such values, but a resubmit does not: pass `changes` without them.

[Held writes](errors.md#held-writes) describes the whole procedure.

#### `schedule(name, at)`, `unschedule(name)`, and `scheduled`

Timers of your own. `schedule(name, at)` makes the object call `scheduled(name)` no later than `at`, in epoch milliseconds, and `unschedule(name)` cancels it. Handle the calls by overriding `scheduled`: `protected override scheduled = (name) => …`.

- **Names** must not start with `syncline:` and must be well-formed text, without lone surrogates.
- **`scheduled(name)` can run more than once** for one `schedule`: if the object is reset during a run, it runs again. Make it safe to repeat.
- **An error it throws is reported, not retried.** See [Errors in your cloud code](errors.md#errors-in-your-cloud-code).
- **A task that resets the object delays it.** See [A task that keeps resetting the object pauses for a day](edge-cases.md#a-task-that-keeps-resetting-the-object-pauses-for-a-day).

### `forward(request, namespace, verify)`

Answers sync requests for private spaces in your Worker's `fetch`. It takes the token from the request, passes it to `verify`, and forwards the request to the Durable Object named after the `space` that `verify` returns.

```ts
    if (pathname === '/sync')
      return forward(request, env.USER_SPACE, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { space: user.id, expiresAt: user.expiresAt };
      });
```

- **`namespace`** is the Durable Object namespace of your `SynclineSpace` class.
- **`verify(token)`** returns `{ space, expiresAt }` for a token you accept, with `expiresAt` in epoch milliseconds, or `undefined` to refuse it. A refused token is answered with 401.
- **It throws when `expiresAt` is not a finite number**: a mistake in `verify`.
- **Web apps on any origin can sync through it.** It answers the browser's CORS preflight and lets any origin read its responses.

### `restoreSpace(namespace, name, at)`

Restores the private space `name` to the time `at`, in epoch milliseconds, within the last 30 days. Shared spaces cannot be restored.

- **It rejects when the object may not have restarted**, such as after a lost connection. The restore then stays staged and applies whenever the object next starts, so call it again.
- **A call after a restore that did apply restores to `at` once more**, discarding the writes made since.
- **Exporters export again, with `reset`, only on the space's next write.** See [After a rebuild or restore](../guides/exports.md#after-a-rebuild-or-restore).

### Shared spaces

Data the cloud writes for many users. The [shared spaces guide](../guides/shared-spaces.md) sets one up step by step.

#### `SharedDefinition`

`{ schema, rules, shards?, chunkRows? }`: what the entry Worker and the shared space both read.

```ts
export const shared = {
  schema: { document, revision, section },
  rules: {
    public: {
      document: { where: "status = 'published'" },
      revision: { where: "status = 'published'" },
      section: { where: "status = 'published'" },
    },
    admin: { document: {}, revision: {}, section: {} },
    team: { document: { by: ['team_id'] } },
    level: { document: { by: ['level'] } },
  },
} satisfies SharedDefinition;
```

| Field | Description |
|---|---|
| `schema` | The space's tables. |
| `rules` | Bucket rules: rule name → table name → `{ where?, by? }`. See [Bucket rules](../guides/bucket-rules.md). |
| `shards` | Number of broadcast shards, default 16. See [Shared spaces](limits.md#shared-spaces) before changing it. |
| `chunkRows` | Modified rows between the saved points new devices start from, default 1,000. |

- **`where`** is a static SQL predicate that reads columns of that table only.
- **`by`** lists the bucket columns: synced columns of integer or text type.
- **A row belongs to bucket `[ruleName, ...byValues]`** when it satisfies `where` and none of its bucket columns is null.
- **A rule needs a name and at least one table**, and its tables declare the same number of `by` columns, with the same types.

#### `SynclineSharedSpace`

The Durable Object class of a shared space. Extend it and call `super(ctx, env, { ...definition, broadcast, cloud?, validation?, onEvent?, retired? })`.

```ts
export class SharedSpace extends SynclineSharedSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { ...shared, cloud, broadcast: (bindings) => bindings.SHARED_BROADCAST });
  }
```

- **`broadcast`** is a function returning the broadcast namespace from `env`.
- **`cloud`, `validation`, `onEvent`, and `retired`** work as on `SynclineSpace`. A `where` in `rules` can read cloud-only columns too.
- **`mutate(write)` is the only way to write**, from your own methods. Here it returns a Promise: await it.
- **`schedule`, `unschedule`, and `scheduled`** work as on `SynclineSpace`, and its alarm is managed the same way.
- **Reach the object by name** (`getByName` or `idFromName`). Its broadcast shards are named after it, so an ID without a name (`idFromString`, `newUniqueId`) throws, and so does a name too long for its shard names. See [Shared spaces](limits.md#shared-spaces).

#### `SynclineBroadcast`

The Durable Object class of the broadcast shards, which hold the devices' live connections. Extend it and call `super(ctx, env, sharedNamespace, onEvent?)`.

```ts
export class SharedBroadcast extends SynclineBroadcast<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, env.SHARED_SPACE);
  }
}
```

Don't override `alarm()` or call `setAlarm`: it closes expired connections from its alarm.

#### `SynclineSharedEntry`

The Worker entrypoint that answers downloads, with Workers Cache in front of it. Extend it and implement `shared()`, returning the shared space's namespace.

```ts
export class SharedEntry extends SynclineSharedEntry<Env> {
  protected shared() {
    return this.env.SHARED_SPACE;
  }
}
```

#### `forwardShared(request, route, verify)`

Answers sync requests for a shared space in your Worker's `fetch`.

```ts
    if (pathname === '/shared') {
      const route = { entry: ctx.exports.SharedEntry, broadcast: env.SHARED_BROADCAST, space: 'shared', definition: shared };
      return forwardShared(request, route, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { buckets: bucketsOf(user), expiresAt: user.expiresAt };
      });
    }
```

- **`route`** is `{ entry, broadcast, space, definition }`: your entrypoint, the broadcast namespace, the name of the shared space, and its `SharedDefinition`.
- **`verify(token)`** returns `{ buckets, expiresAt }` for a token you accept, or `undefined` to refuse it. A refused token is answered with 401.
- **`entry` is `ctx.exports.<YourEntry>` itself.** Syncline calls it with the subscription as props, and an entry reached without props throws.
- **`buckets`** are the buckets the user reads: `[ruleName, ...params]`, with a string for a text column and a number for an integer column.
- **It throws for a mistake in `verify`**: a bucket that breaks the rules, a bucket over 256 bytes, a subscription over 8,192 bytes encoded as JSON, or an `expiresAt` that is not a finite number.
- **Web apps on any origin can sync through it**, as with `forward`.

### Security

- Access ends when the token expires: HTTP pulls call `verify` every time, but an open connection keeps the space or subscription its token granted until `expiresAt`, so keep token lifetimes short where revoking access must take effect quickly.
- Shared space pull URLs carry bucket parameters and primary keys (in the cursor, and base64-encoded, not encrypted, in the landed subscription), so they appear wherever URLs are logged: use opaque IDs rather than emails or names as bucket parameters and as primary keys of shared tables.
- Syncline bounds the work of each pull but not how often a valid token pulls, and every pull the cache does not answer reads billed rows: add a rate limiting rule on the sync route if tokens can fall into hostile hands.

### Types

`SynclineEvent` (an event `onEvent` receives; see [Events](errors.md#events)), `Transaction` (the `tx` of `mutate`), `Exporter` (`{ position(): Promise<string | undefined>; write({ from, next, reset, patch }): Promise<void> }`), `Identity` (`{ space, expiresAt }`), `SharedIdentity` (`{ buckets, expiresAt }`), `Bucket`, `BucketRules`, `Change` (one changed row of a write), `ValidationError`.
