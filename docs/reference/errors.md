# Errors

English | [简体中文](zh-CN/errors.md)

Syncline recovers from network and cloud failures on its own, keeping pending writes until the cloud confirms them. When a failure needs a decision, sync stops or the write is held, and Syncline tells your app.

## On the device

### Where errors show

- `openSyncline` throws for mistakes in your options or table declarations.
- `waitForReady()` rejects when the database cannot open.
- `write()` rejects when a write breaks a rule. The whole transaction rolls back.
- `status()` and `onStatus` show `downloadError`, `uploadError`, and `updateNeeded`.
- `sync()` rejects with the same error the status shows, or with `signal.reason` when you abort it. Only `PendingWritesError` and `AccountMismatchError` can be checked with `instanceof`.
- `onHeld` reports writes the cloud refused to run.

The app's error handler (`reportError` on web, `ErrorUtils` on iOS and Android) receives:

- Errors thrown inside your `onStatus`, `onChange`, or `onHeld` listeners.
- Problems Syncline works around on its own, such as local data that did not match the cloud and was downloaded again, a downloaded value the local column cannot hold, or a failed background sync.

Sync goes on. Log these errors.

### Handled for you

| What happens | What the device does |
|---|---|
| Offline, or the connection drops or stalls | Retries with backoff and uploads pending writes once back |
| `token` throws, returns `undefined` or `null`, or takes more than 30 seconds | Sets `downloadError` and retries with backoff |
| The cloud rejects the token (HTTP 401) | Sets `downloadError` and retries with backoff |
| The token expires | Gets a new token and reconnects |
| The cloud closes the connection | Depends on the code; see [Connection errors](limits.md#connection-errors) |

For these, show `downloadError` or `uploadError` to the user if you want; there is nothing to fix in your code. A token your cloud keeps rejecting is the exception: check `verify`. When the user signs out, call `close()` instead of throwing from `token`, or the device keeps retrying.

### A write throws

`write()` rejects and nothing is saved. Causes:

- `ValidationError`: a value does not match its column declaration (type, non-null, enum, length, JSON) or your `validation` schema, or the primary key is too long. `issues` lists the fields and reasons.
- A [value](limits.md#values) or [write](limits.md#size) past a limit, such as invalid text, NaN, or too many rows.
- A row that references a missing row through a foreign key.
- A write to a `readOnly` table.

Fix the data and write again.

### A write appears, then disappears

The cloud refused to run it, for example because it broke a [limit](limits.md) or a rule in your cloud code. The cloud holds the write instead of dropping it.

Listen with `onHeld` to show the user what failed. It reports each held write at most once, when the cloud confirms that write to this device, so a write whose confirmation a background `syncOnce` received is never reported to it. The cloud keeps the full list; see [Held writes](#held-writes).

### `waitForReady()` rejects

The database could not open. `downloadError` shows the same error, and `sync()` rejects with it. Causes:

- A declaration that does not match the stored database, such as a changed column type. See [Schema](limits.md#schema).
- `PendingWritesError` or another tab, below.
- An invalid `url`.

On iOS and Android, a failed open closes the database, except after an invalid `url`: call `close()` before opening it again.

A shared space differs: `openShared()` creates its tables in the background, so a declaration that does not match leaves its `waitForReady()` resolved. The failure shows in its `downloadError` while it retries.

### `PendingWritesError` when opening the database

The previous user still has writes waiting to upload, and opening for a new `userID` would delete them.

Ask the previous user to sign in again and sync. To drop their writes instead, open with `discardPending: true`.

### `AccountMismatchError` in `downloadError`

The cloud reports a different account than the one this database first synced with. Sync stops so nothing uploads to the wrong account. Reopen the database with the current user's `userID`.

### `updateNeeded` is true

The cloud is newer than the app, or the app uses a table or column the cloud has retired. Sync pauses. Ship an app update.

### `uploadError` shows code 1007

The cloud rejected a batch of uploaded writes: it could not read it, or the batch broke a limit. Uploads stop until the app restarts or calls `resync()`. If the writes can never succeed, `resync({ discardPending: true })` drops them.

### Downloads keep failing after I added a trigger

A trigger on a synced table that raises an error can block downloads, or opening the database. Remove the trigger, or stop it from raising when Syncline changes rows.

### The web app works in one tab only

Only one tab per site can open the database. A second tab fails with an error starting with `Local database is open in another tab`: its `waitForReady()` rejects and `downloadError` shows the error. Close the other tab, then reload this one.

### Syncline's own tables were changed

Only Syncline may change its own tables (`_syncline_*`). If a pending write stored there cannot be read back, the device cannot sync or open the database. Delete the local database with `delete()` to recover. Pending writes are lost.

## In the cloud

### Held writes

A pushed write that fails to run is held, not dropped. The device keeps syncing.

In a method of your `SynclineSpace`:

1. List held writes with `held()`. Each has its `reason` and the original `changes`.
2. Fix the cause: your cloud code, a rule, or the data.
3. Call `resubmit(client, id)` to run it again, pass new `changes` to replace it, or pass `[]` to discard it.

### Errors in your cloud code

- `SynclineSpace` throws when the schema breaks a rule in [Schema](limits.md#schema).
- `SynclineSharedSpace` throws when reached without a name, or with a name too long for its shards (see [Shared spaces](limits.md#shared-spaces)).
- `mutate()` throws and rolls back when the write breaks a rule, such as a [limit](limits.md#size) or `ValidationError`.
- `forward` and `forwardShared` throw when `verify` returns a value they cannot use, such as an `expiresAt` that is not a finite number or a bucket that breaks your rules. The device's request fails: `downloadError` shows it and the device retries with backoff.
- An error thrown by your `scheduled(name)` goes to `reportError`, and the task is not run again. Call `schedule` inside it to retry.
- A task of yours that keeps resetting the object pauses, and the failure goes to `reportError` (see Scheduled tasks in [Things to know](limits.md#things-to-know)).

### Events

Pass `onEvent` to `SynclineSpace`, `SynclineSharedSpace`, or `SynclineBroadcast` to log events or raise alerts. It receives a `SynclineEvent`. Keep the callback fast. An error it throws goes to `reportError` and does not affect sync.

Alert on these:

| Event | Meaning | What to do |
|---|---|---|
| `write.held` | A pushed write failed and is held | See [Held writes](#held-writes) |
| `push.failed` | An upload could not be read (the device gets 1007) or stored (the device retries) | Read `reason`. A space past its [storage limit](limits.md#cloud-storage) keeps failing |
| `export.failed` | An exporter failed. It is retried with backoff, and its destination falls behind | Fix the exporter or its destination |
| `upkeep.failed` | A background step failed, such as building an index. It is retried with backoff | Read `reason` if it keeps failing |
| `notice.failed` | A broadcast shard missed a live update. It is retried with backoff | Read `reason` if it keeps failing |
| `write.skipped` | A device skipped write IDs. This should not happen | [Open an issue](https://github.com/hht/syncline/issues) with the event |

These are for logs and metrics:

| Event | Meaning |
|---|---|
| `values.dropped` | A pushed write set retired tables or columns. Those values were dropped and the rest ran |
| `write.resubmitted` | A held write ran after `resubmit` |
| `schema.changed` | Tables or columns entered or left sync when the object started |
| `cookie.reset` | A device's position is not in the shared space's history, so it downloads everything again |
| `chunk.pulled` | A device downloaded a chunk of rows |
| `connection.closed` | The cloud closed a connection, with its code and reason |
